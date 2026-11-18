// The forge's in-memory store: repositories, git objects and refs, issues, pull requests,
// labels and comments. Everything is deterministic: no wall clock, no Math.random. Commit
// timestamps and merged_at come from a monotonically increasing counter seeded at the
// scenario epoch, so a replay of the same requests produces byte-identical state.

import { VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import {
  ZERO_OID,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './gitpack.ts';

export const DEFAULT_BRANCH = 'main';

/** Deterministic clock: 2025-01-01T00:00:00Z + one second per stamp. */
let tick = 0;
export function nextTimestamp(): number {
  return 1_735_689_600 + (tick += 1);
}
export function isoOf(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
  /** Cached serialized REST body; cleared on any mutation. */
  jsonCache: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  /** Shared issue + pull-request counter (GitHub numbers issues and PRs together). */
  nextNumber: number;
  /** Bumped on any ref/object change; caches key off it. */
  version: number;
  commitCache: Map<string, ParsedCommit & { author: string; committer: string }>;
  treeCache: Map<string, TreeEntry[]>;
  flatCache: Map<string, Map<string, { oid: string; mode: string }>>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextCommentId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  seq = 0;
  /** (repoId|wants|haves|depth|shallow) -> pack bytes. Bounded, FIFO. */
  packCache = new Map<string, Buffer>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.seq++,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      version: 0,
      commitCache: new Map(),
      treeCache: new Map(),
      flatCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    this.dropPackCacheForRepo(repo.id);
    return true;
  }

  dropPackCacheForRepo(repoId: number): void {
    const prefix = `${repoId}|`;
    for (const key of [...this.packCache.keys()]) {
      if (key.startsWith(prefix)) this.packCache.delete(key);
    }
  }

  putPackCache(key: string, pack: Buffer): void {
    if (this.packCache.size >= 32) {
      const first = this.packCache.keys().next().value;
      if (first !== undefined) this.packCache.delete(first);
    }
    this.packCache.set(key, pack);
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data, oid });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  parseCommitCached(repo: Repo, oid: string): (ParsedCommit & { author: string; committer: string }) | null {
    const hit = repo.commitCache.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const parsed = parseCommit(obj.data);
    const text = obj.data.toString('utf8');
    const author = /^(?:author )([^\n]+)$/m.exec(text)?.[1] ?? '';
    const committer = /^(?:committer )([^\n]+)$/m.exec(text)?.[1] ?? '';
    const full = { ...parsed, author, committer };
    repo.commitCache.set(oid, full);
    return full;
  }

  parseTreeCached(repo: Repo, oid: string): TreeEntry[] | null {
    const hit = repo.treeCache.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    repo.treeCache.set(oid, entries);
    return entries;
  }

  /** Flatten a tree to path -> {oid, mode}, memoized (trees are immutable). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const hit = repo.flatCache.get(treeOid);
    if (hit) return hit;
    const flat = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.parseTreeCached(repo, oid);
      if (!entries) return;
      for (const e of entries) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else flat.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    repo.flatCache.set(treeOid, flat);
    return flat;
  }

  /** Rebuild a tree from a flat path map, storing every new tree object. */
  rebuildTree(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        const seg = segs[i] as string;
        let child = node.dirs.get(seg);
        if (!child) {
          child = make();
          node.dirs.set(seg, child);
        }
        node = child;
      }
      node.files.set(segs[segs.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** All objects reachable from `tips` (commits, tags, trees, blobs). */
  collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = this.parseCommitCached(repo, oid);
        if (c) {
          stack.push(c.tree);
          for (const p of c.parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        const entries = this.parseTreeCached(repo, oid);
        if (entries) for (const e of entries) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const t = parseTag(obj.data);
        if (t.object) stack.push(t.object);
      }
    }
    return seen;
  }

  /** True when `anc` is `desc` or an ancestor of it (commit parent walk). */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === anc) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.parseCommitCached(repo, oid);
      if (c) for (const p of c.parents) stack.push(p);
    }
    return false;
  }

  /** First-parent chain from `tip` (newest first). */
  firstParentChain(repo: Repo, tip: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = tip;
    while (cur !== null && cur !== ZERO_OID && !seen.has(cur)) {
      seen.add(cur);
      const c = this.parseCommitCached(repo, cur);
      if (!c) break;
      chain.push(cur);
      cur = c.parents[0] ?? null;
    }
    return chain;
  }

  /** The merge-base of two commits: the first common ancestor found by BFS from both sides. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      const c = this.parseCommitCached(repo, oid);
      if (c) for (const p of c.parents) stackA.push(p);
    }
    const seenB = new Set<string>();
    const stackB = [b];
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (fromA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const c = this.parseCommitCached(repo, oid);
      if (c) for (const p of c.parents) stackB.push(p);
    }
    return null;
  }

  // ---------------------------------------------------------- commits the server creates

  ident(): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  }

  /** Create a commit object on `repo` (author/committer = viewer, deterministic timestamp). */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const ts = nextTimestamp();
    const ident = this.ident();
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const lines: string[] = [`tree ${treeOid}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${ident} ${ts} +0000`);
    lines.push(`committer ${ident} ${ts} +0000`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** Peel a tag object to its target commit (following tag chains). */
  peelToCommit(repo: Repo, oid: string): string {
    let cur = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = repo.objects.get(cur);
      if (!obj) return cur;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        cur = parseTag(obj.data).object;
        continue;
      }
      return cur;
    }
    return cur;
  }

  // ---------------------------------------------------------- diffs and merges

  diffFlat(
    base: Map<string, { oid: string; mode: string }>,
    head: Map<string, { oid: string; mode: string }>,
  ): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return out;
  }

  /** Line diff counts for two blob contents (small files; LCS on lines). */
  lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const n = a.length;
    const m = b.length;
    // LCS lengths, two rows.
    let prev = new Array<number>(m + 1).fill(0);
    let cur = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
      cur.fill(0);
    }
    const lcs = prev[m];
    return { additions: m - lcs, deletions: n - lcs };
  }

  /**
   * Three-way merge check for a pull request: apply the head's changes (baseTip's tree is the
   * merge-base side) onto the base tip's tree. Returns null on conflict.
   */
  mergeTree(repo: Repo, baseTip: string, headTip: string): string | null {
    const baseC = this.parseCommitCached(repo, baseTip);
    const headC = this.parseCommitCached(repo, headTip);
    if (!baseC || !headC) return null;
    const mergeBaseOid = this.mergeBase(repo, baseTip, headTip);
    const baseFlat = this.flattenTree(repo, baseC.tree);
    const headFlat = this.flattenTree(repo, headC.tree);
    const ancestorFlat: Map<string, { oid: string; mode: string }> =
      mergeBaseOid === null ? new Map() : this.flattenTree(repo, this.parseCommitCached(repo, mergeBaseOid)?.tree ?? '');
    const result = new Map(baseFlat);
    const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const anc = ancestorFlat.get(path);
      const head = headFlat.get(path);
      const tip = baseFlat.get(path);
      if (head?.oid === anc?.oid) continue; // head did not change it
      if (tip?.oid === anc?.oid) {
        // tip did not change it; take the head's version
        if (head) result.set(path, head);
        else result.delete(path);
        continue;
      }
      if (head?.oid === tip?.oid) continue; // both changed to the same
      return null; // both changed differently: conflict
    }
    return this.rebuildTree(repo, result);
  }

  /** Squash-merge a pull request. Returns the merge commit sha, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return null;
    const tree = this.mergeTree(repo, baseTip, headTip);
    if (tree === null) return null;
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
    const commit = this.makeCommit(repo, tree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, commit);
    repo.version += 1;
    this.dropPackCacheForRepo(repo.id);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = isoOf(nextTimestamp());
    pull.mergeCommitSha = commit;
    return commit;
  }
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Opaque Relay-style global id: base64url of `Kind:payload`. Never the plain number. */
export function globalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** A cursor for GraphQL connection pagination: base64url of the 0-based index. */
export function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

export function indexOfCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : -1;
  } catch {
    return -1;
  }
}
