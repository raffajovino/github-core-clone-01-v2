// Model Context Protocol over Streamable HTTP (revision 2026-07-28): server/discover,
// initialize (legacy handshake), tools/list and tools/call. Every POST answers one plain
// JSON body; a body that is not JSON answers HTTP 400 with JSON-RPC -32700.

import type { ServerResponse } from 'node:http';
import type { ReqCtx } from './ctx.ts';
import { isRecord, jsonError, sendJson } from './ctx.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'github-core-clone-01-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

interface ToolOutcome {
  ok: boolean;
  /** The value for content text + structuredContent. */
  value: unknown;
  error?: string;
}

function toolOk(value: unknown): ToolOutcome {
  return { ok: true, value };
}

function toolErr(error: string): ToolOutcome {
  return { ok: false, value: { error }, error };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const required = TOOL_REQUIRED[name];
  if (required === undefined) return toolErr(`Unknown tool: ${name}`);
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return toolErr(`missing required argument: ${key}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolErr('Invalid repository name');
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return toolErr('Repository already exists');
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErr('Repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErr('Repository not found');
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: store.seq++,
        comments: [],
        jsonCache: null,
      };
      repo.issues.push(issue);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErr('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const arr = list.map((i) => issueJson(repo, i));
      return { ok: true, value: arr, error: undefined };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErr('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolErr('head or base branch does not exist');
      const dupe = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (dupe) return toolErr('A pull request already exists for this head branch');
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErr('Repository not found');
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return toolErr('Pull request not found');
      if (pull.merged || pull.state === 'closed') return toolOk(pullJson(repo, pull));
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return toolErr('Merge conflict');
      return toolOk(pullJson(repo, pull));
    }
    default:
      return toolErr(`Unknown tool: ${name}`);
  }
}

/** Extract a JSON-RPC id from a body that failed to parse (best effort). */
function idFromRaw(raw: string): string | number | null {
  const m = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(raw);
  if (!m) return null;
  const token = m[1] as string;
  if (token.startsWith('"')) return token.slice(1, -1);
  return Number.parseInt(token, 10);
}

function rpcResult(res: ServerResponse, id: string | number | null, result: unknown, reqId: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result }, reqId);
}

function rpcError(res: ServerResponse, status: number, id: string | number | null, code: number, message: string, reqId: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } }, reqId);
}

/** POST /mcp (GET/DELETE answer 405). */
export function handleMcp(store: Store, ctx: ReqCtx, res: ServerResponse): void {
  if (ctx.method !== 'POST') {
    jsonError(res, 405, 'Method Not Allowed', ctx.reqId);
    return;
  }
  if (!ctx.authed) {
    // No Authorization header (or a wrong token): the transport refuses before any tool exists.
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.reqId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } }));
    return;
  }
  const raw = ctx.body === null ? '' : ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    rpcError(res, 400, idFromRaw(raw), -32700, 'Parse error', ctx.reqId);
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    rpcError(res, 200, isRecord(parsed) ? (parsed.id as string | number | null) ?? null : null, -32600, 'Invalid Request', ctx.reqId);
    return;
  }
  const id = (parsed.id as string | number | null) ?? null;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const method = parsed.method;

  // Notifications carry no id: acknowledge and stop.
  if (parsed.id === undefined) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.reqId });
    res.end('{}');
    return;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    rpcResult(res, id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }, ctx.reqId);
    return;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
    rpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }, ctx.reqId);
    return;
  }

  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS }, ctx.reqId);
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!Object.prototype.hasOwnProperty.call(TOOL_REQUIRED, toolName)) {
      rpcError(res, 200, id, -32602, `Unknown tool: ${toolName}`, ctx.reqId);
      return;
    }
    const outcome = callTool(store, toolName, args);
    const text = JSON.stringify(outcome.value);
    const result: Record<string, unknown> = {
      content: [{ type: 'text', text }],
      structuredContent: outcome.value,
      isError: !outcome.ok,
    };
    rpcResult(res, id, result, ctx.reqId);
    return;
  }

  rpcError(res, 200, id, -32601, `Method not found: ${method}`, ctx.reqId);
}
