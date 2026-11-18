// Git object model, pkt-line codec and pack read/write. Plain objects only, never deltas:
// the suite accepts plain packs, and skipping delta encoding keeps both push parsing and
// clone pack-building fast and simple.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
  /** The object's id when already known (store keys, pack parsing): avoids re-hashing. */
  oid?: string;
}

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of `<type> <size>\0<data>`, hex. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** SHA-1 of raw bytes, hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex length digits (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode lines ('flush'/'delim' for control packets) into one buffer. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  /** Data payload (empty for control packets). */
  payload: Buffer;
}

/**
 * Parse a whole buffer of pkt-lines. Throws on a malformed length prefix — callers treat
 * that as a 400 / a survivable protocol error, never a crash.
 */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated at the length prefix');
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText) || Number.isNaN(len)) {
      throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    }
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('pkt-line truncated at the payload');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- packs

/** Write a pack (version 2, plain objects, SHA-1 trailer). Objects are sorted for determinism. */
export function writePack(objects: readonly GitObject[]): Buffer {
  // One hash per object, then sort by the id: the old comparator re-hashed both sides of
  // every comparison (O(n log n) SHA-1s on a 600-object pack ≈ 2/3 of the build time).
  const sorted = objects
    .map((obj) => ({ type: obj.type, data: obj.data, oid: obj.oid ?? hashObject(obj.type, obj.data) }))
    .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const obj of sorted) {
    const comp = deflateSync(obj.data);
    // Type/size varint: first byte low 4 bits = size, next 3 bits = type, MSB = continue.
    const size = obj.data.length;
    const typeCode = TYPE_CODES[obj.type];
    const header: number[] = [];
    let s = size;
    let first = (typeCode << 4) | (s & 0x0f);
    s >>>= 4;
    if (s !== 0) first |= 0x80;
    header.push(first);
    while (s !== 0) {
      let b = s & 0x7f;
      s >>>= 7;
      if (s !== 0) b |= 0x80;
      header.push(b);
    }
    parts.push(Buffer.from(header));
    parts.push(comp);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Find the end of one zlib stream starting at `off`.
 * Fast path: a deflate stream holding `size` bytes is at most size + 11 bytes long (stored
 * blocks cost 5 bytes per 64 KiB, plus 2 header + 4 adler), so a slice of size + 32 always
 * contains the whole stream. Inflate it, re-deflate the result (zlib's deflate is
 * deterministic for the same input and level), and the re-deflated length is the exact end —
 * verified byte-for-byte against the slice, so a compressor that disagrees falls through to
 * the binary search instead of ever returning a wrong end. ~2 zlib calls per object instead
 * of ~log2(range) ≈ 11 binary-search inflates.
 */
function zlibStreamEnd(buf: Buffer, off: number, maxEnd: number, size: number): number {
  const cap = Math.min(maxEnd, off + size + 32);
  try {
    const data = inflateSync(buf.subarray(off, cap));
    if (data.length === size) {
      const comp = deflateSync(data);
      const end = off + comp.length;
      if (end <= maxEnd && buf.subarray(off, end).equals(comp)) return end;
    }
  } catch {
    // Slice too short for this compressor, or not a stream at all: binary-search below.
  }
  let lo = off;
  let hi = maxEnd;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  // Verify the found end really inflates (a truncated stream at maxEnd would have thrown).
  inflateSync(buf.subarray(off, lo));
  return lo;
}

export interface ParsedPack {
  version: number;
  /** Objects keyed by their recomputed id. */
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a pack: plain objects only (a delta entry is an error — this server never sends them). */
export function readPack(buf: Buffer): ParsedPack {
  if (buf.length < 12 + 20) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  const expectedTrailer = createHash('sha1').update(buf.subarray(0, trailerAt)).digest('hex');
  const actualTrailer = buf.subarray(trailerAt).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= trailerAt) throw new Error('pack ends before its declared object count');
    // Type/size varint.
    let b = buf[off];
    off += 1;
    const typeCode = (b! >> 4) & 0x07;
    let size = b! & 0x0f;
    let shift = 4;
    while ((b! & 0x80) !== 0) {
      b = buf[off];
      off += 1;
      size |= (b! & 0x7f) << shift;
      shift += 7;
    }
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`unsupported pack object type ${typeCode} (deltas are not accepted)`);
    const end = zlibStreamEnd(buf, off, trailerAt, size);
    const data = inflateSync(buf.subarray(off, end));
    if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, inflated ${data.length}`);
    off = end;
    const oid = hashObject(type, data);
    objects.set(oid, { type, data, oid });
  }
  return { version, objects, deltaCount: 0 };
}

// ---------------------------------------------------------------- object parsing

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object: tree, parents, message (author/committer lines skipped). */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) throw new Error('malformed tree entry (no space)');
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree entry (no NUL/oid)');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries (git sorts: directories as if suffixed with '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const object = /^(?:object )([0-9a-f]{40})$/m.exec(text)?.[1] ?? '';
  const type = /^(?:type )(\w+)$/m.exec(text)?.[1] ?? '';
  const tag = /^(?:tag )([^\n]+)$/m.exec(text)?.[1] ?? '';
  return { object, type, tag };
}
