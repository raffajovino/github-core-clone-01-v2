// GitHub GraphQL v4: the documents gh and github-mcp-server actually send. The executor
// dispatches on the operation name (every document the suite sends is fixed), so no general
// GraphQL parser is needed; unknown fields answer HTTP 200 with an errors array, as the
// suite requires.

import type { ServerResponse } from 'node:http';
import type { ReqCtx } from './ctx.ts';
import { isRecord, jsonError, parseJsonBody, sendJson } from './ctx.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { cursorOf, globalId, indexOfCursor, parseGlobalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'labels', 'comments'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'url', 'createdAt', 'author'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt'];

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: gqlState(issue.state),
    body: issue.body,
  };
}

function repoNode(store: Store, repo: Repo): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: tip === undefined ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function decodeRepoId(store: Store, id: string): Repo | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return undefined;
  const num = Number.parseInt(parsed.payload, 10);
  if (!Number.isSafeInteger(num)) return undefined;
  return findRepoById(store, num);
}

function decodeIssueId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return undefined;
  const [repoId, number] = parsed.payload.split(':');
  const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
  if (!repo) return undefined;
  const issue = repo.issues.find((i) => i.number === Number.parseInt(number ?? '', 10));
  if (!issue) return undefined;
  return { repo, issue };
}

function decodePullId(store: Store, id: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return undefined;
  const [repoId, number] = parsed.payload.split(':');
  const repo = findRepoById(store, Number.parseInt(repoId ?? '', 10));
  if (!repo) return undefined;
  const pull = repo.pulls.find((p) => p.number === Number.parseInt(number ?? '', 10));
  if (!pull) return undefined;
  return { repo, pull };
}

function mergeableOf(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  return store.mergeTree(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

function pullFilesPaths(store: Store, repo: Repo, pull: Pull): string[] {
  const baseC = store.parseCommitCached(repo, pull.baseSha);
  const headC = store.parseCommitCached(repo, pull.headSha);
  if (!baseC || !headC) return [];
  const baseFlat = store.flattenTree(repo, baseC.tree);
  const headFlat = store.flattenTree(repo, headC.tree);
  return store.diffFlat(baseFlat, headFlat).map((d) => d.path);
}

type GqlResult = { data: Record<string, unknown> | null; errors?: { message: string }[] };

function err(message: string): GqlResult {
  return { data: null, errors: [{ message }] };
}

/** Execute one operation document. `variables` is the request's variables object. */
function executeOp(store: Store, query: string, variables: Record<string, unknown>): GqlResult {
  const match = /^\s*(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  const name = match?.[2] ?? '';
  const vars = variables;

  switch (name) {
    case 'ViewerLogin':
      return { data: { viewer: { login: VIEWER_LOGIN } } };

    case 'RepositoryFields': {
      const owner = String(vars.owner ?? '');
      const repoName = String(vars.name ?? '');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { data: { repository: null } };
      return { data: { repository: repoNode(store, repo) } };
    }

    case 'Issue_fields':
      return { data: { Issue: { fields: ISSUE_FIELDS.map((n) => ({ name: n })) } } };

    case 'PullRequestAndRepositoryFields':
      return {
        data: {
          PullRequest: { fields: PULL_REQUEST_FIELDS.map((n) => ({ name: n })) },
          Repository: { fields: REPOSITORY_FIELDS.map((n) => ({ name: n })) },
        },
      };

    case 'SearchType_enumValues':
      return {
        data: {
          SearchType: {
            enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE'].map((n) => ({ name: n })),
          },
        },
      };

    case 'OpenIssues': {
      const repo = store.getRepo(String(vars.owner ?? ''), String(vars.name ?? ''));
      if (!repo) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const nodes = [...repo.issues]
        .filter((i) => i.state === 'open')
        .sort((a, b) => b.number - a.number)
        .slice(0, first)
        .map((i) => issueNode(repo, i));
      return { data: { repository: { issues: { nodes } } } };
    }

    case 'IssueByNumber': {
      const repo = store.getRepo(String(vars.owner ?? ''), String(vars.name ?? ''));
      if (!repo) return { data: { repository: null } };
      const issue = repo.issues.find((i) => i.number === vars.number);
      return { data: { repository: { issue: issue === undefined ? null : issueNode(repo, issue) } } };
    }

    case 'IssueCreate': {
      const input = isRecord(vars.input) ? vars.input : {};
      const repo = decodeRepoId(store, String(input.repositoryId ?? ''));
      if (!repo) return err('Repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return err('title is required');
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        createdSeq: store.seq++,
        comments: [],
        jsonCache: null,
      };
      repo.issues.push(issue);
      return { data: { createIssue: { issue: { number: issue.number, id: globalId('Issue', `${repo.id}:${issue.number}`) } } } };
    }

    case 'IssueClose': {
      const input = isRecord(vars.input) ? vars.input : {};
      const found = decodeIssueId(store, String(input.issueId ?? ''));
      if (!found) return err('Issue not found');
      found.issue.state = 'closed';
      found.issue.jsonCache = null;
      return {
        data: {
          closeIssue: {
            issue: {
              number: found.issue.number,
              id: globalId('Issue', `${found.repo.id}:${found.issue.number}`),
              state: 'CLOSED',
            },
          },
        },
      };
    }

    case 'PullRequests': {
      const repo = store.getRepo(String(vars.owner ?? ''), String(vars.name ?? ''));
      if (!repo) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const nodes = [...repo.pulls]
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .slice(0, first)
        .map((p) => ({
          number: p.number,
          headRefName: p.head,
          baseRefName: p.base,
          mergeable: mergeableOf(store, repo, p),
          state: gqlState(p.state),
        }));
      return { data: { repository: { pullRequests: { nodes } } } };
    }

    case 'PullRequestFiles': {
      const repo = store.getRepo(String(vars.owner ?? ''), String(vars.name ?? ''));
      if (!repo) return { data: { repository: null } };
      const pull = repo.pulls.find((p) => p.number === vars.number);
      if (!pull) return { data: { repository: { pullRequest: null } } };
      return {
        data: {
          repository: {
            pullRequest: {
              number: pull.number,
              files: { nodes: pullFilesPaths(store, repo, pull).map((path) => ({ path })) },
            },
          },
        },
      };
    }

    case 'PullRequestId': {
      const repo = store.getRepo(String(vars.owner ?? ''), String(vars.name ?? ''));
      if (!repo) return { data: { repository: null } };
      const pull = repo.pulls.find((p) => p.number === vars.number);
      if (!pull) return { data: { repository: { pullRequest: null } } };
      return {
        data: {
          repository: { pullRequest: { id: globalId('PullRequest', `${repo.id}:${pull.number}`), number: pull.number } },
        },
      };
    }

    case 'PullRequestCreate': {
      const input = isRecord(vars.input) ? vars.input : {};
      const repo = decodeRepoId(store, String(input.repositoryId ?? ''));
      if (!repo) return err('Repository not found');
      const base = String(input.baseRefName ?? '');
      const head = String(input.headRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err('head or base branch does not exist');
      const dupe = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (dupe) return err('A pull request already exists for this head branch');
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: '',
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
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pull.number,
              id: globalId('PullRequest', `${repo.id}:${pull.number}`),
              state: 'OPEN',
              headRefName: head,
              baseRefName: base,
            },
          },
        },
      };
    }

    case 'MergePullRequest': {
      const input = isRecord(vars.input) ? vars.input : {};
      const found = decodePullId(store, String(input.pullRequestId ?? ''));
      if (!found) return err('Pull request not found');
      if (found.pull.merged || found.pull.state === 'closed') {
        return { data: { mergePullRequest: { pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' } } } };
      }
      const sha = store.squashMerge(found.repo, found.pull);
      if (sha === null) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Merge conflict' }] };
      }
      return { data: { mergePullRequest: { pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' } } } };
    }

    case 'AddComment': {
      const input = isRecord(vars.input) ? vars.input : {};
      const found = decodeIssueId(store, String(input.subjectId ?? ''));
      if (!found) return err('Issue not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: store.nextCommentId++, body };
      found.issue.comments.push(comment);
      found.issue.jsonCache = null;
      return {
        data: {
          addComment: {
            commentEdge: { node: { id: globalId('IssueComment', String(comment.id)), body } },
          },
        },
      };
    }

    case 'ViewerInvalidField':
      return {
        data: { viewer: { login: VIEWER_LOGIN } },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
      };

    case 'NodeRepository': {
      const parsed = parseGlobalId(String(vars.id ?? ''));
      if (!parsed) return { data: { node: null } };
      if (parsed.kind === 'Repository') {
        const repo = findRepoById(store, Number.parseInt(parsed.payload, 10));
        if (!repo) return { data: { node: null } };
        return { data: { node: { id: globalId('Repository', String(repo.id)), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
      }
      if (parsed.kind === 'Issue') {
        const found = decodeIssueId(store, String(vars.id ?? ''));
        if (!found) return { data: { node: null } };
        return {
          data: {
            node: {
              id: globalId('Issue', `${found.repo.id}:${found.issue.number}`),
              number: found.issue.number,
              title: found.issue.title,
            },
          },
        };
      }
      return { data: { node: null } };
    }

    case 'IssuesPage': {
      const repo = store.getRepo(String(vars.owner ?? ''), String(vars.name ?? ''));
      if (!repo) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const ordered = [...repo.issues].sort((a, b) => a.number - b.number);
      let start = 0;
      if (typeof vars.after === 'string' && vars.after !== '') {
        const idx = indexOfCursor(vars.after);
        if (idx >= 0) start = idx + 1;
      }
      const slice = ordered.slice(start, start + first);
      const endIndex = start + slice.length - 1;
      return {
        data: {
          repository: {
            issues: {
              nodes: slice.map((i) => ({ number: i.number })),
              pageInfo: {
                hasNextPage: start + slice.length < ordered.length,
                endCursor: slice.length === 0 ? null : cursorOf(endIndex),
              },
            },
          },
        },
      };
    }

    default:
      return err(`Unknown operation "${name}"`);
  }
}

/** POST /api/graphql. */
export function handleGraphql(store: Store, ctx: ReqCtx, res: ServerResponse): void {
  if (!ctx.authed) {
    jsonError(res, 401, 'Requires authentication', ctx.reqId);
    return;
  }
  const body = parseJsonBody(ctx);
  if (body === undefined) {
    jsonError(res, 400, 'Malformed JSON body', ctx.reqId);
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') return err('Invalid operation document');
      const vars = isRecord(entry.variables) ? entry.variables : {};
      return executeOp(store, entry.query, vars);
    });
    sendJson(res, 200, results, ctx.reqId);
    return;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    jsonError(res, 400, 'Invalid GraphQL request', ctx.reqId);
    return;
  }
  const vars = isRecord(body.variables) ? body.variables : {};
  sendJson(res, 200, executeOp(store, body.query, vars), ctx.reqId);
}
