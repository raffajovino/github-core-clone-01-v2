// Shared request context and JSON reply helpers for the REST/GraphQL/MCP surfaces.
// Every JSON reply carries a non-empty X-GitHub-Request-Id (a per-process counter, so a
// replay of the same requests produces the same ids).

import type { ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}`;
}

export interface ReqCtx {
  method: string;
  /** Path segments, decoded, without empty parts. */
  segments: string[];
  query: URLSearchParams;
  /** Raw request body (null when none was sent). */
  body: Buffer | null;
  /** Whether the Authorization header carries the trial token. */
  authed: boolean;
  /** The request id for this reply's X-GitHub-Request-Id header. */
  reqId: string;
  /** Host header, for absolute pagination URLs. */
  host: string;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, reqId: string, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, 'x-github-request-id': reqId, ...extra });
  res.end(buf);
}

/** Send a pre-serialized JSON buffer (the read workload's hot path). */
export function sendJsonBuf(res: ServerResponse, status: number, buf: Buffer, reqId: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, 'x-github-request-id': reqId, ...extra });
  res.end(buf);
}

export function jsonError(res: ServerResponse, status: number, message: string, reqId: string): void {
  sendJson(res, status, { message }, reqId);
}

/** Parse a JSON body; on failure returns null (the caller answers 400). */
export function parseJsonBody(ctx: ReqCtx): unknown | null {
  if (ctx.body === null || ctx.body.length === 0) return null;
  try {
    return JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse `?page=` / `?per_page=` with GitHub's defaults (page 1, per_page 30, cap 100). */
export function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

/**
 * Paginate `items` (already in list order) and answer the Link header value for the next
 * page, or null when this is the last page. `base` is the absolute URL without query; the
 * other query parameters are carried over into the next link.
 */
export function paginate<T>(items: readonly T[], query: URLSearchParams, base: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage >= items.length) return { page: slice, link: null };
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return { page: slice, link: `<${base}?${next.toString()}>; rel="next"` };
}
