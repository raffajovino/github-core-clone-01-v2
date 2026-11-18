// HTTP server: routing, auth, body reading. The hot paths (GET issue, git advertisement)
// dispatch without touching the body stream; only POST/PUT/PATCH accumulate a body.
//
// Auth: the trial bearer token arrives as MAKEFUN_SHOP_TOKEN (wire.ts TOKEN_ENV). Every
// surface except /healthz requires `Authorization: Bearer <that token>`; a missing or
// different token answers 401 with a JSON message body.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';
import { jsonError, nextRequestId, sendJson, type ReqCtx } from './ctx.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

function pathSegments(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(store: Store = new Store()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      url = new URL('/', 'http://entry');
    }
    const segments = pathSegments(url.pathname);
    const reqId = nextRequestId();
    const authed = SHOP_TOKEN !== '' && req.headers.authorization === `Bearer ${SHOP_TOKEN}`;

    const dispatch = (body: Buffer | null): void => {
      const ctx: ReqCtx = {
        method,
        segments,
        query: url.searchParams,
        body,
        authed,
        reqId,
        host: req.headers.host ?? 'entry',
      };

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { ok: true }, reqId);
        return;
      }

      // REST v3 under /api/v3 (handleRest sees the segments after /api/v3).
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        handleRest(store, { ...ctx, segments: segments.slice(2) }, res);
        return;
      }

      // GraphQL v4.
      if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        handleGraphql(store, ctx, res);
        return;
      }

      // MCP over Streamable HTTP.
      if (segments.length === 1 && segments[0] === 'mcp') {
        handleMcp(store, ctx, res);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
        if (!authed) {
          jsonError(res, 401, 'Requires authentication', reqId);
          return;
        }
        const owner = segments[0] as string;
        const repoName = (segments[1] as string).slice(0, -4);
        const repo = store.getRepo(owner, repoName);
        const sub = segments.slice(2).join('/');
        if (method === 'GET' && sub === 'info/refs') {
          handleInfoRefs(store, repo, ctx.query.get('service') ?? '', req.headers['git-protocol'] === 'version=2', res);
          return;
        }
        if (repo === undefined) {
          jsonError(res, 404, 'Not Found', reqId);
          return;
        }
        if (method === 'POST' && sub === 'git-upload-pack') {
          handleUploadPack(store, repo, body ?? EMPTY_BODY, req.headers['git-protocol'] === 'version=2', res);
          return;
        }
        if (method === 'POST' && sub === 'git-receive-pack') {
          handleReceivePack(store, repo, body ?? EMPTY_BODY, res);
          return;
        }
        jsonError(res, 404, 'Not Found', reqId);
        return;
      }

      // Everything else: GitHub's JSON 404.
      jsonError(res, 404, 'Not Found', reqId);
    };

    // GET/HEAD/DELETE carry no body in this suite: dispatch at once (the read workload's
    // 2,000 sequential GETs on one keep-alive connection must not wait on the stream).
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
      dispatch(null);
      return;
    }

    // POST/PUT/PATCH: accumulate the body, then dispatch.
    const chunks: Buffer[] = [];
    let size = 0;
    let answered = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!answered) {
          answered = true;
          jsonError(res, 413, 'Request body too large', reqId);
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (answered) return;
      dispatch(chunks.length === 0 ? EMPTY_BODY : Buffer.concat(chunks, size));
    });
    req.on('error', () => {
      if (!answered) {
        answered = true;
        if (!res.headersSent) jsonError(res, 400, 'Bad Request', reqId);
      }
    });
  });
}
