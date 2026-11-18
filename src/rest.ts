// GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels,
// pull requests, files and merges. Status codes and shapes follow the suite's checks
// exactly; every reply is JSON with a non-empty X-GitHub-Request-Id.

import type { ServerResponse } from 'node:http';
import type { ReqCtx } from './ctx.ts';
import { isRecord, jsonError, paginate, parseJsonBody, sendJson, sendJsonBuf } from './ctx.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import {
  isoOf,
  splitLines,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- object builders

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: isoOf(1_735_689_600),
    updated_at: isoOf(1_735_689_600),
    pushed_at: isoOf(1_735_689_600),
    homepage: null,
    language: null,
    visibility: repo.private ? 'private' : 'public',
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoOf(1_735_689_600 + issue.createdSeq),
    updated_at: isoOf(1_735_689_600 + issue.createdSeq),
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The cached serialized issue body for the read workload's hot path. */
export function issueJsonBuf(store: Store, repo: Repo, issue: Issue): Buffer {
  if (issue.jsonCache === null) {
    issue.jsonCache = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  }
  return issue.jsonCache;
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: isoOf(1_735_689_600 + pull.createdSeq),
    updated_at: isoOf(1_735_689_600 + pull.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoOf(1_735_689_600 + issue.createdSeq),
    updated_at: isoOf(1_735_689_600 + issue.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha, url: `/api/v3/repos/commits/${sha}` }, protected: false };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const c = store.parseCommitCached(repo, oid);
  if (!c) return null;
  const ident = (raw: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw);
    if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(1_735_689_600) };
    return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    // GitHub presents the commit message without the trailing newline the raw
    // commit object carries (makeCommit appends one, as git does).
    commit: { message: c.message.replace(/\n+$/, ''), author: ident(c.author), committer: ident(c.committer) },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
  };
}

// ---------------------------------------------------------------- contents helpers

/** Resolve a `?ref=` (branch name, or a 40-hex oid) to a tip commit oid. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (/^[0-9a-f]{40}$/.test(ref)) return store.getObject(repo, ref) ? ref : null;
  return repo.refs.get(`refs/heads/${ref}`) ?? null;
}

/** Walk a tree by path segments; returns the object at the path (or null). */
function lookupPath(store: Store, repo: Repo, treeOid: string, segments: readonly string[]): { oid: string; mode: string } | null {
  let cur = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = store.parseTreeCached(repo, cur);
    if (!entries) return null;
    const seg = segments[i] as string;
    const found = entries.find((e) => e.name === seg);
    if (!found) return null;
    if (i === segments.length - 1) return { oid: found.oid, mode: found.mode };
    if (found.mode !== '40000') return null;
    cur = found.oid;
  }
  return null;
}

function base64Of(data: Buffer): string {
  return data.toString('base64');
}

// ---------------------------------------------------------------- the handler

/** Handle a request under /api/v3. Always answers. */
export function handleRest(store: Store, ctx: ReqCtx, res: ServerResponse): void {
  const { segments, method } = ctx;
  if (!ctx.authed) {
    jsonError(res, 401, 'Requires authentication', ctx.reqId);
    return;
  }
  // A JSON body, when one was sent, must parse.
  let body: unknown = null;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (ctx.body !== null && ctx.body.length > 0) {
      body = parseJsonBody(ctx);
      if (body === undefined) {
        jsonError(res, 400, 'Malformed JSON body', ctx.reqId);
        return;
      }
    }
  }

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') {
      jsonError(res, 404, 'Not Found', ctx.reqId);
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, ctx.reqId, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  const [first] = segments as [string, ...string[]];

  if (first === 'meta' && segments.length === 1) {
    if (method !== 'GET') return jsonError(res, 404, 'Not Found', ctx.reqId);
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }, ctx.reqId);
    return;
  }

  if (first === 'user' && segments.length === 1) {
    if (method !== 'GET') return jsonError(res, 404, 'Not Found', ctx.reqId);
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' }, ctx.reqId);
    return;
  }

  if (first === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const base = `http://${ctx.host}/api/v3/user/repos`;
      const { page, link } = paginate(repos, ctx.query, base);
      sendJson(res, 200, page.map(repoJson), ctx.reqId, link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const input = isRecord(body) ? body : {};
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        jsonError(res, 422, 'name is required', ctx.reqId);
        return;
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        private: input.private === true,
        description: typeof input.description === 'string' ? input.description : '',
      });
      if (repo === null) {
        jsonError(res, 422, 'Repository already exists', ctx.reqId);
        return;
      }
      sendJson(res, 201, repoJson(repo), ctx.reqId);
      return;
    }
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }

  if (first === 'repos' && segments.length >= 3) {
    handleRepoRoute(store, ctx, res, body);
    return;
  }

  jsonError(res, 404, 'Not Found', ctx.reqId);
}

function repoOf(store: Store, ctx: ReqCtx): Repo | undefined {
  const owner = ctx.segments[1] as string;
  const name = ctx.segments[2] as string;
  return store.getRepo(owner, name);
}

function handleRepoRoute(store: Store, ctx: ReqCtx, res: ServerResponse, body: unknown): void {
  const { segments, method } = ctx;
  const repo = repoOf(store, ctx);
  if (repo === undefined) {
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }
  const rest = segments.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo), ctx.reqId);
      return;
    }
    if (method === 'PATCH') {
      const input = isRecord(body) ? body : {};
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      sendJson(res, 200, repoJson(repo), ctx.reqId);
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': ctx.reqId });
      res.end();
      return;
    }
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }

  const [kind, ...tail] = rest as [string, ...string[]];

  // Branches
  if (kind === 'branches' && tail.length === 0 && method === 'GET') {
    const list: Record<string, unknown>[] = [];
    for (const [name, oid] of [...repo.refs.entries()].sort()) {
      if (name.startsWith('refs/heads/')) list.push(branchJson(name.slice('refs/heads/'.length), oid));
    }
    sendJson(res, 200, list, ctx.reqId);
    return;
  }
  if (kind === 'branches' && tail.length === 1 && method === 'GET') {
    const oid = repo.refs.get(`refs/heads/${tail[0]}`);
    if (oid === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    sendJson(res, 200, branchJson(tail[0] as string, oid), ctx.reqId);
    return;
  }

  // Commits
  if (kind === 'commits' && tail.length === 0 && method === 'GET') {
    const shaParam = ctx.query.get('sha');
    const tip = resolveRef(store, repo, shaParam);
    if (tip === null) {
      if (shaParam !== null && shaParam !== '') return jsonError(res, 404, 'Not Found', ctx.reqId);
      sendJson(res, 200, [], ctx.reqId);
      return;
    }
    const chain = store.firstParentChain(repo, tip);
    const list: Record<string, unknown>[] = [];
    for (const oid of chain) {
      const entry = commitJson(store, repo, oid);
      if (entry) list.push(entry);
    }
    sendJson(res, 200, list, ctx.reqId);
    return;
  }

  // Git Data: create a ref
  if (kind === 'git' && tail[0] === 'refs' && tail.length === 1 && method === 'POST') {
    const input = isRecord(body) ? body : {};
    const ref = typeof input.ref === 'string' ? input.ref : '';
    const sha = typeof input.sha === 'string' ? input.sha : '';
    if (!/^refs\/(heads|tags)\/[^\s]+$/.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
      jsonError(res, 422, 'Invalid ref or sha', ctx.reqId);
      return;
    }
    const obj = store.getObject(repo, sha);
    if (!obj || (ref.startsWith('refs/heads/') && obj.type !== 'commit')) {
      jsonError(res, 422, 'Object does not exist', ctx.reqId);
      return;
    }
    if (repo.refs.has(ref)) {
      jsonError(res, 422, 'Reference already exists', ctx.reqId);
      return;
    }
    repo.refs.set(ref, sha);
    repo.version += 1;
    store.dropPackCacheForRepo(repo.id);
    sendJson(res, 201, { ref, object: { sha } }, ctx.reqId);
    return;
  }
  // Git Data: read one ref
  if (kind === 'git' && tail[0] === 'refs' && tail[1] === 'heads' && tail.length === 3 && method === 'GET') {
    const oid = repo.refs.get(`refs/heads/${tail[2]}`);
    if (oid === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    sendJson(res, 200, { ref: `refs/heads/${tail[2]}`, object: { sha: oid } }, ctx.reqId);
    return;
  }

  // Contents
  if (kind === 'contents') {
    handleContents(store, ctx, res, repo, tail, body);
    return;
  }

  // Labels
  if (kind === 'labels' && method === 'POST' && tail.length === 0) {
    const input = isRecord(body) ? body : {};
    const name = typeof input.name === 'string' ? input.name : '';
    if (name === '') return jsonError(res, 422, 'name is required', ctx.reqId);
    const existing = repo.labels.get(name);
    if (existing) {
      sendJson(res, 201, { name: existing.name, color: existing.color }, ctx.reqId);
      return;
    }
    const color = typeof input.color === 'string' ? input.color : 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color }, ctx.reqId);
    return;
  }
  if (kind === 'labels' && method === 'GET' && tail.length === 0) {
    sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })), ctx.reqId);
    return;
  }

  // Issues
  if (kind === 'issues') {
    handleIssues(store, ctx, res, repo, tail, body);
    return;
  }

  // Pull requests
  if (kind === 'pulls') {
    handlePulls(store, ctx, res, repo, tail, body);
    return;
  }

  jsonError(res, 404, 'Not Found', ctx.reqId);
}

// ---------------------------------------------------------------- contents

function handleContents(store: Store, ctx: ReqCtx, res: ServerResponse, repo: Repo, tail: string[], body: unknown): void {
  const { method } = ctx;
  const path = tail.join('/');
  const segments = path.split('/').filter((s) => s !== '');

  if (method === 'GET') {
    const tip = resolveRef(store, repo, ctx.query.get('ref'));
    if (tip === null) return jsonError(res, 404, 'Not Found', ctx.reqId);
    const commit = store.parseCommitCached(repo, tip);
    if (!commit) return jsonError(res, 404, 'Not Found', ctx.reqId);
    if (segments.length === 0) {
      // The repository root: list the root tree.
      const entries = store.parseTreeCached(repo, commit.tree) ?? [];
      const list = entries.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
      }));
      sendJson(res, 200, list, ctx.reqId);
      return;
    }
    const found = lookupPath(store, repo, commit.tree, segments);
    if (!found) return jsonError(res, 404, 'Not Found', ctx.reqId);
    if (found.mode === '40000') {
      const entries = store.parseTreeCached(repo, found.oid) ?? [];
      const list = entries.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: `${path}/${e.name}`,
        sha: e.oid,
      }));
      sendJson(res, 200, list, ctx.reqId);
      return;
    }
    const blob = store.getObject(repo, found.oid);
    if (!blob || blob.type !== 'blob') return jsonError(res, 404, 'Not Found', ctx.reqId);
    const name = segments[segments.length - 1] as string;
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name,
      path,
      sha: found.oid,
      content: base64Of(blob.data),
    }, ctx.reqId);
    return;
  }

  if (method === 'PUT') {
    if (path === '') return jsonError(res, 404, 'Not Found', ctx.reqId);
    const input = isRecord(body) ? body : {};
    const message = typeof input.message === 'string' ? input.message : 'Update file';
    const contentB64 = typeof input.content === 'string' ? input.content : '';
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const sha = typeof input.sha === 'string' ? input.sha : null;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    let parents: string[] = [];
    let flat: Map<string, { oid: string; mode: string }>;
    if (tip === undefined) {
      const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (base !== undefined) {
        // Create the branch from the default branch tip.
        const baseCommit = store.parseCommitCached(repo, base);
        if (!baseCommit) return jsonError(res, 404, 'Not Found', ctx.reqId);
        flat = new Map(store.flattenTree(repo, baseCommit.tree));
        parents = [base];
      } else {
        // Empty repo: the first file creates the root commit on the branch.
        flat = new Map();
        parents = [];
      }
    } else {
      const commit = store.parseCommitCached(repo, tip);
      if (!commit) return jsonError(res, 404, 'Not Found', ctx.reqId);
      flat = new Map(store.flattenTree(repo, commit.tree));
      parents = [tip];
    }
    const existing = flat.get(path);
    if (existing) {
      if (sha === null) return jsonError(res, 422, 'sha is required to update a file', ctx.reqId);
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) return jsonError(res, 409, 'sha does not match the current file', ctx.reqId);
    } else if (sha !== null) {
      return jsonError(res, 422, 'sha does not match: the file does not exist', ctx.reqId);
    }
    const data = Buffer.from(contentB64, 'base64');
    const blobOid = store.putObject(repo, 'blob', data);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const tree = store.rebuildTree(repo, flat);
    const newCommit = store.makeCommit(repo, tree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, newCommit);
    repo.version += 1;
    store.dropPackCacheForRepo(repo.id);
    const name = segments[segments.length - 1] as string;
    sendJson(res, existing ? 200 : 201, {
      content: { name, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64', content: contentB64 },
      commit: { sha: newCommit },
    }, ctx.reqId);
    return;
  }

  if (method === 'DELETE') {
    if (path === '') return jsonError(res, 404, 'Not Found', ctx.reqId);
    const input = isRecord(body) ? body : {};
    const message = typeof input.message === 'string' ? input.message : 'Delete file';
    const sha = typeof input.sha === 'string' ? input.sha : null;
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    const commit = store.parseCommitCached(repo, tip);
    if (!commit) return jsonError(res, 404, 'Not Found', ctx.reqId);
    const flat = new Map(store.flattenTree(repo, commit.tree));
    const existing = flat.get(path);
    if (!existing) return jsonError(res, 404, 'Not Found', ctx.reqId);
    if (sha !== null && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return jsonError(res, 409, 'sha does not match the current file', ctx.reqId);
    }
    flat.delete(path);
    const tree = store.rebuildTree(repo, flat);
    const newCommit = store.makeCommit(repo, tree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, newCommit);
    repo.version += 1;
    store.dropPackCacheForRepo(repo.id);
    sendJson(res, 200, { commit: { sha: newCommit } }, ctx.reqId);
    return;
  }

  jsonError(res, 404, 'Not Found', ctx.reqId);
}

// ---------------------------------------------------------------- issues

function handleIssues(store: Store, ctx: ReqCtx, res: ServerResponse, repo: Repo, tail: string[], body: unknown): void {
  const { method } = ctx;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const base = `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/issues`;
      const { page, link } = paginate(list, ctx.query, base);
      sendJson(res, 200, page.map((i) => issueJson(repo, i)), ctx.reqId, link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const input = isRecord(body) ? body : {};
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return jsonError(res, 422, 'title is required', ctx.reqId);
      const labels = Array.isArray(input.labels) ? input.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return jsonError(res, 422, `Label '${label}' does not exist`, ctx.reqId);
      }
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels,
        createdSeq: store.seq++,
        comments: [],
        jsonCache: null,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue), ctx.reqId);
      return;
    }
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1) return jsonError(res, 404, 'Not Found', ctx.reqId);
  const issue = repo.issues.find((i) => i.number === number);

  if (tail.length === 1) {
    if (issue === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    if (method === 'GET') {
      sendJsonBuf(res, 200, issueJsonBuf(store, repo, issue), ctx.reqId);
      return;
    }
    if (method === 'PATCH') {
      const input = isRecord(body) ? body : {};
      if (typeof input.state === 'string' && (input.state === 'open' || input.state === 'closed')) issue.state = input.state;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      issue.jsonCache = null;
      sendJson(res, 200, issueJson(repo, issue), ctx.reqId);
      return;
    }
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)), ctx.reqId);
      return;
    }
    if (method === 'POST') {
      const input = isRecord(body) ? body : {};
      const text = typeof input.body === 'string' ? input.body : '';
      if (text === '') return jsonError(res, 422, 'body is required', ctx.reqId);
      const comment = { id: store.nextCommentId++, body: text };
      issue.comments.push(comment);
      issue.jsonCache = null;
      sendJson(res, 201, commentJson(repo, issue, comment), ctx.reqId);
      return;
    }
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }

  jsonError(res, 404, 'Not Found', ctx.reqId);
}

// ---------------------------------------------------------------- pull requests

function pullFiles(store: Store, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseC = store.parseCommitCached(repo, pull.baseSha);
  const headC = store.parseCommitCached(repo, pull.headSha);
  if (!baseC || !headC) return [];
  const baseFlat = store.flattenTree(repo, baseC.tree);
  const headFlat = store.flattenTree(repo, headC.tree);
  const diffs = store.diffFlat(baseFlat, headFlat);
  const out: Record<string, unknown>[] = [];
  for (const d of diffs) {
    const oldText = d.oldOid === null ? '' : (store.getObject(repo, d.oldOid)?.data.toString('utf8') ?? '');
    const newText = d.newOid === null ? '' : (store.getObject(repo, d.newOid)?.data.toString('utf8') ?? '');
    let additions = 0;
    let deletions = 0;
    if (d.status === 'added') additions = splitLines(newText).length;
    else if (d.status === 'removed') deletions = splitLines(oldText).length;
    else {
      const counts = store.lineDiff(oldText, newText);
      additions = counts.additions;
      deletions = counts.deletions;
    }
    out.push({ filename: d.path, status: d.status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

function handlePulls(store: Store, ctx: ReqCtx, res: ServerResponse, repo: Repo, tail: string[], body: unknown): void {
  const { method } = ctx;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const base = `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/pulls`;
      const { page, link } = paginate(list, ctx.query, base);
      sendJson(res, 200, page.map((p) => pullJson(repo, p)), ctx.reqId, link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const input = isRecord(body) ? body : {};
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : '';
      if (title === '' || head === '' || base === '') return jsonError(res, 422, 'title, head and base are required', ctx.reqId);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return jsonError(res, 422, 'head or base branch does not exist', ctx.reqId);
      }
      const dupe = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (dupe) return jsonError(res, 422, 'A pull request already exists for this head branch', ctx.reqId);
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: store.seq++,
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull), ctx.reqId);
      return;
    }
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1) return jsonError(res, 404, 'Not Found', ctx.reqId);
  const pull = repo.pulls.find((p) => p.number === number);

  if (tail.length === 1) {
    if (pull === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull), ctx.reqId);
      return;
    }
    jsonError(res, 404, 'Not Found', ctx.reqId);
    return;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    sendJson(res, 200, pullFiles(store, repo, pull), ctx.reqId);
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return jsonError(res, 404, 'Not Found', ctx.reqId);
    if (pull.merged || pull.state === 'closed') {
      jsonError(res, 405, 'Pull request is already closed', ctx.reqId);
      return;
    }
    const sha = store.squashMerge(repo, pull);
    if (sha === null) {
      jsonError(res, 405, 'Merge conflict', ctx.reqId);
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' }, ctx.reqId);
    return;
  }

  jsonError(res, 404, 'Not Found', ctx.reqId);
}
