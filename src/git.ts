// Git smart HTTP: upload-pack v2 (+ v0 advertisement), ls-refs, fetch, receive-pack v0.
// Plain packs only, never deltas; every pack the server builds is cached per ref state.

import type { ServerResponse } from 'node:http';
import { DEFAULT_BRANCH, type Repo, type Store } from './store.ts';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isObjectId,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitpack.ts';

// ---------------------------------------------------------------- advertisements

const V2_ADVERTISEMENT: Buffer = encodePktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

export interface RefLine {
  name: string;
  oid: string;
}

export function sortedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const tip = headTip(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${tip} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        // Peeled tag line: the tag's target commit.
        const peeled = peelTag(repo, ref.oid);
        lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function peelTag(repo: Repo, tagOid: string): string {
  let cur = tagOid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const text = obj.data.toString('utf8');
    const target = /^(?:object )([0-9a-f]{40})$/m.exec(text)?.[1];
    if (!target) return cur;
    cur = target;
  }
  return cur;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, repo: Repo | undefined, service: string, isV2: boolean, res: ServerResponse): void {
  if (repo === undefined) {
    sendText(res, 404, 'Not Found');
    return;
  }
  if (service === 'git-upload-pack') {
    if (isV2) {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': V2_ADVERTISEMENT.length });
      res.end(V2_ADVERTISEMENT);
      return;
    }
    const body = v0Advertisement(repo, 'git-upload-pack');
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
    res.end(body);
    return;
  }
  if (service === 'git-receive-pack') {
    const body = v0Advertisement(repo, 'git-receive-pack');
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': body.length });
    res.end(body);
    return;
  }
  sendText(res, 400, 'unknown service');
}

function sendText(res: ServerResponse, status: number, text: string): void {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------- ls-refs (v2)

/** One ls-refs response line (without the trailing newline handling). */
export function lsRefsLines(
  repo: Repo,
  opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): string[] {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const tip = headTip(repo);
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (opts.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${opts.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    }
    return lines;
  }
  if (opts.symrefs && keep('HEAD')) {
    lines.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (opts.peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') line += ` peeled:${peelTag(repo, ref.oid)}`;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------- fetch: the send set

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface SendSet {
  /** Objects to pack (commits, trees, blobs, tags). */
  objects: Set<string>;
  newShallow: string[];
  newUnshallow: string[];
}

/**
 * Which objects a fetch sends: reachable from wants, minus what the client holds, cut at
 * the depth boundary. `haves` that are shallow boundaries hold only themselves, not their
 * parents (that is what deepen walks through).
 */
export function computeSendSet(store: Store, repo: Repo, req: FetchRequest): SendSet {
  const shallowSet = new Set(req.shallow);
  // Held commits: from haves, stopping descent at shallow boundaries.
  const heldCommits = new Set<string>();
  {
    const stack = [...req.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (heldCommits.has(oid)) continue;
      const c = store.parseCommitCached(repo, oid);
      if (!c) continue;
      heldCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const p of c.parents) stack.push(p);
    }
  }
  // Held objects: held commits + the tree/blob closure of each held commit.
  const heldObjects = new Set<string>(heldCommits);
  for (const oid of heldCommits) {
    const c = store.parseCommitCached(repo, oid);
    if (c) {
      for (const o of store.collectReachable(repo, [c.tree])) heldObjects.add(o);
    }
  }

  const sendCommits = new Set<string>();
  const boundary = new Set<string>();
  // BFS from wants with generation numbers; resolve tag wants to their target commit.
  const queue: { oid: string; gen: number }[] = [];
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = store.peelToCommit(repo, want);
      queue.push({ oid: target, gen: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    }
  }
  const seenGen = new Map<string, number>();
  for (let qi = 0; qi < queue.length; qi += 1) {
    const { oid, gen } = queue[qi] as { oid: string; gen: number };
    const prev = seenGen.get(oid);
    if (prev !== undefined && prev <= gen) continue;
    seenGen.set(oid, gen);
    if (req.depth !== null && gen >= req.depth) continue;
    const c = store.parseCommitCached(repo, oid);
    if (!c) continue;
    if (!heldCommits.has(oid)) {
      sendCommits.add(oid);
      if (req.depth !== null && gen === req.depth - 1) boundary.add(oid);
    }
    const blocked = heldCommits.has(oid) && !shallowSet.has(oid);
    if (req.depth === null) {
      if (!blocked) for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
    } else if (gen + 1 < req.depth) {
      for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
    }
  }

  // Tag objects for tag wants.
  const sendObjects = new Set<string>();
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (obj && obj.type === 'tag' && !heldObjects.has(want)) sendObjects.add(want);
  }
  for (const oid of sendCommits) {
    sendObjects.add(oid);
    const c = store.parseCommitCached(repo, oid);
    if (c) {
      for (const o of store.collectReachable(repo, [c.tree])) {
        if (!heldObjects.has(o)) sendObjects.add(o);
      }
    }
  }

  const newShallow = req.depth === null ? [] : [...boundary].sort();
  const newUnshallow: string[] = [];
  if (req.shallow.length > 0) {
    for (const b of req.shallow) {
      const c = store.parseCommitCached(repo, b);
      if (!c) continue;
      const parentsHeld = c.parents.every((p) => sendCommits.has(p) || heldCommits.has(p));
      if (parentsHeld && !boundary.has(b)) newUnshallow.push(b);
    }
    newUnshallow.sort();
  }
  return { objects: sendObjects, newShallow, newUnshallow };
}

function packCacheKey(repo: Repo, req: FetchRequest): string {
  return `${repo.id}|${[...req.wants].sort().join(',')}|${[...req.haves].sort().join(',')}|${req.depth ?? ''}|${[...req.shallow].sort().join(',')}`;
}

/** Build (or reuse from cache) the pack for a fetch's send set. */
export function packForSend(store: Store, repo: Repo, req: FetchRequest, send: SendSet): Buffer {
  const key = packCacheKey(repo, req);
  const hit = store.packCache.get(key);
  if (hit) return hit;
  const objs: GitObject[] = [];
  for (const oid of send.objects) {
    const obj = repo.objects.get(oid);
    if (obj) objs.push(obj);
  }
  const pack = writePack(objs);
  store.putPackCache(key, pack);
  return pack;
}

// ---------------------------------------------------------------- v2 fetch response

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(payload));
  }
  return out;
}

/** POST /{owner}/{repo}.git/git-upload-pack (v2 command=fetch or command=ls-refs). */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, isV2: boolean, res: ServerResponse): void {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendText(res, 400, 'malformed pkt-line');
    return;
  }
  if (!isV2) {
    handleUploadPackV0(store, repo, packets, res);
    return;
  }
  const first = packets.find((p) => p.kind === 'data');
  const command = first?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    let afterDelim = false;
    for (const p of packets) {
      if (p.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (p.kind !== 'data' || !afterDelim) continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const lines = lsRefsLines(repo, { peel, symrefs, unborn, prefixes });
    const out = encodePktLines([...lines.map((l) => `${l}\n`), 'flush']);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  if (command === 'command=fetch') {
    const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
    let afterDelim = false;
    for (const p of packets) {
      if (p.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (p.kind !== 'data' || !afterDelim) continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isSafeInteger(n) && n > 0) req.depth = n;
      }
    }
    req.wants = [...new Set(req.wants)].filter(isObjectId);
    req.haves = [...new Set(req.haves)].filter(isObjectId);
    req.shallow = [...new Set(req.shallow)].filter(isObjectId);
    const send = computeSendSet(store, repo, req);
    const parts: Buffer[] = [];
    const hasPack = send.objects.size > 0;
    const hasShallow = send.newShallow.length > 0 || send.newUnshallow.length > 0;
    // Sections are separated by delim (0001); only the last section ends with flush
    // (protocol-v2). Real git sends NO acknowledgments section at all when the request
    // carries no haves: it expects 'packfile' first and dies on 'acknowledgments'.
    const DELIM = Buffer.from('0001', 'ascii');
    const FLUSH = Buffer.from('0000', 'ascii');
    const hasAck = req.haves.length > 0;
    // acknowledgments (only when the client sent haves: negotiation happened)
    if (hasAck) {
      const ackLines: string[] = [];
      const held = req.haves.filter((h) => {
        const c = store.parseCommitCached(repo, h);
        return c !== null;
      });
      if (held.length === 0) ackLines.push('NAK\n');
      else {
        for (const h of held) ackLines.push(`ACK ${h}\n`);
        if (send.objects.size > 0) ackLines.push('ready\n');
      }
      parts.push(pktLine('acknowledgments\n'));
      for (const l of ackLines) parts.push(pktLine(l));
      parts.push(hasPack || hasShallow ? DELIM : FLUSH);
    }
    // shallow-info
    if (hasShallow) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of send.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of send.newUnshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(hasPack ? DELIM : FLUSH);
    }
    // packfile
    if (hasPack) {
      const pack = packForSend(store, repo, req, send);
      parts.push(pktLine('packfile\n'));
      for (const pkt of sidebandPackets(pack)) parts.push(pkt);
      parts.push(FLUSH);
    }
    const out = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  sendText(res, 400, `unknown v2 command ${JSON.stringify(command)}`);
}

/** Minimal v0 fetch: same send set, NAK/ACK lines + sideband pack. */
function handleUploadPackV0(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>, res: ServerResponse): void {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (clean.startsWith('want ')) req.wants.push(clean.slice(5).trim());
    else if (clean.startsWith('have ')) req.haves.push(clean.slice(5).trim());
    else if (clean.startsWith('deepen ')) {
      const n = Number.parseInt(clean.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) req.depth = n;
    }
  }
  req.wants = [...new Set(req.wants)].filter(isObjectId);
  req.haves = [...new Set(req.haves)].filter(isObjectId);
  const send = computeSendSet(store, repo, req);
  const parts: Buffer[] = [];
  if (req.haves.length === 0) parts.push(pktLine('NAK\n'));
  else {
    for (const h of req.haves) parts.push(pktLine(`ACK ${h}\n`));
  }
  if (send.objects.size > 0) {
    const pack = packForSend(store, repo, req, send);
    for (const pkt of sidebandPackets(pack)) parts.push(pkt);
  }
  const out = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}

// ---------------------------------------------------------------- receive-pack (v0)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse one pkt-line starting at `off`; returns the packet and the next offset. */
function readOnePktLine(body: Buffer, off: number): { kind: string; payload: Buffer; next: number } {
  if (off + 4 > body.length) throw new Error('pkt-line truncated at the length prefix');
  const lenText = body.subarray(off, off + 4).toString('ascii');
  const len = parseInt(lenText, 16);
  if (!/^[0-9a-fA-F]{4}$/.test(lenText) || Number.isNaN(len)) throw new Error('bad pkt-line length');
  if (len === 0) return { kind: 'flush', payload: Buffer.alloc(0), next: off + 4 };
  if (len === 1) return { kind: 'delim', payload: Buffer.alloc(0), next: off + 4 };
  if (len === 2) return { kind: 'response-end', payload: Buffer.alloc(0), next: off + 4 };
  if (off + len > body.length) throw new Error('pkt-line truncated at the payload');
  return { kind: 'data', payload: body.subarray(off + 4, off + len), next: off + len };
}

/** Fast-forward check with an O(1) fast path: a push whose new commit directly names the
 * current tip as a parent is always a fast-forward (the linear-push case, which is every
 * push of the benchmark's 200-push chain). Anything else falls back to the full
 * reachability walk. */
function isFastForward(store: Store, repo: Repo, current: string, newOid: string): boolean {
  if (current === newOid) return true;
  const c = store.parseCommitCached(repo, newOid);
  if (c !== null && c.parents.includes(current)) return true;
  return store.isAncestor(repo, current, newOid);
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  const commands: PushCommand[] = [];
  let caps = new Set<string>();
  let off = 0;
  let packStart = body.length;
  try {
    for (;;) {
      const pkt = readOnePktLine(body, off);
      off = pkt.next;
      if (pkt.kind === 'flush') {
        packStart = off;
        break;
      }
      if (pkt.kind !== 'data') continue;
      const line = pkt.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const cmdPart = nul >= 0 ? line.slice(0, nul) : line;
      if (commands.length === 0 && nul >= 0) {
        caps = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
      }
      const parts = cmdPart.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string)) {
        throw new Error(`bad push command ${JSON.stringify(cmdPart.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch {
    sendText(res, 400, 'malformed push command list');
    return;
  }
  if (commands.length === 0) {
    sendText(res, 400, 'push needs at least one command');
    return;
  }

  const sideband = caps.has('side-band-64k');
  const report = (unpackOk: boolean, unpackDetail: string, refs: { ref: string; ok: boolean; reason: string }[]): void => {
    const inner: (string | 'flush')[] = [`unpack ${unpackDetail}\n`];
    for (const r of refs) inner.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    inner.push('flush');
    const innerBytes = encodePktLines(inner);
    let out: Buffer;
    if (sideband) {
      const parts: Buffer[] = [];
      for (let i = 0; i < innerBytes.length; ) {
        // Split the inner stream into sideband packets at pkt-line boundaries.
        // Guard the inner length: a malformed value must never spin this loop forever.
        const len = parseInt(innerBytes.subarray(i, i + 4).toString('ascii'), 16);
        if (!Number.isFinite(len) || len < 0 || i + (len === 0 ? 4 : len) > innerBytes.length) break;
        const chunkLen = len === 0 ? 4 : len;
        const chunk = innerBytes.subarray(i, i + chunkLen);
        parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
        i += chunkLen;
      }
      parts.push(Buffer.from('0000', 'ascii'));
      out = Buffer.concat(parts);
    } else {
      out = innerBytes;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
    res.end(out);
  };

  // Unpack the pack (when one was sent).
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    let parsed;
    try {
      parsed = readPack(packBytes);
    } catch (err) {
      report(false, err instanceof Error ? err.message : 'unpack error', []);
      return;
    }
    for (const [oid, obj] of parsed.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'failed' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'failed' });
        continue;
      }
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      changed = true;
      continue;
    }
    const obj = repo.objects.get(cmd.newOid);
    if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'failed' });
      continue;
    }
    if (current !== ZERO_OID && !isFastForward(store, repo, current, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
    changed = true;
  }
  if (changed) {
    repo.version += 1;
    store.dropPackCacheForRepo(repo.id);
  }
  report(true, 'ok', results);
}
