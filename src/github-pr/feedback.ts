import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pullRequestSummary, resultText, runGh } from "./gh.ts";
import type { Capability, PullRequest } from "./types.ts";

const GRAPHQL_PAGE_SIZE = 100;

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${GRAPHQL_PAGE_SIZE}, after: $endCursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          originalStartLine
          diffSide
          startDiffSide
          comments(first: ${GRAPHQL_PAGE_SIZE}) {
            nodes {
              id
              body
              author {
                login
              }
              createdAt
              url
            }
            commentsPageInfo: pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query($id: ID!, $endCursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: ${GRAPHQL_PAGE_SIZE}, after: $endCursor) {
        nodes { id body author { login } createdAt url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface IssueComment {
  id: number;
  author?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
}

interface Review {
  id: number;
  author?: string;
  body?: string;
  state?: string;
  submittedAt?: string;
  commitId?: string;
  url?: string;
}

interface ReviewComment {
  id: string;
  body?: string;
  author?: { login?: string };
  createdAt?: string;
  url?: string;
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  diffSide?: string;
  startDiffSide?: string;
  comments: {
    id: string;
    body?: string;
    author?: string;
    createdAt?: string;
    url?: string;
  }[];
  commentsPageTruncated?: boolean;
}

interface CommentConnection {
  nodes: ReviewComment[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

type RawReviewThread = Omit<ReviewThread, "comments"> & {
  comments: Omit<CommentConnection, "pageInfo"> & { commentsPageInfo: CommentConnection["pageInfo"] };
};

function parsePaginatedArray(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
    if (!(parsed as unknown[]).every(Array.isArray)) {
      throw new Error("Invalid paginated array data.");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid array data.");
  }
  const items = parsed.flatMap((item) => (Array.isArray(item) ? item : [item]));
  if (items.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("Invalid array item data.");
  }
  return items;
}

function validateCommentConnection(connection: CommentConnection | undefined): CommentConnection {
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    typeof connection.pageInfo?.hasNextPage !== "boolean" ||
    connection.nodes.some((comment) => !comment || typeof comment.id !== "string")
  ) {
    throw new Error("Invalid inline thread comment data.");
  }
  return connection;
}

async function parseReviewThreadPages(
  pi: ExtensionAPI,
  cwd: string,
  capability: Extract<Capability, { available: true }>,
  stdout: string,
  signal?: AbortSignal,
): Promise<ReviewThread[]> {
  const parsed: unknown = JSON.parse(stdout);
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const threads: ReviewThread[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const data = page as {
      errors?: unknown[];
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: RawReviewThread[] } } } };
    } | null;
    const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (data?.errors?.length || !Array.isArray(nodes)) throw new Error("Invalid inline review thread data.");
    for (const thread of nodes) {
      if (!thread || typeof thread.id !== "string") throw new Error("Invalid inline review thread data.");
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      const { commentsPageInfo, ...commentData } = thread.comments;
      let connection = validateCommentConnection({ ...commentData, pageInfo: commentsPageInfo });
      const comments = [...connection.nodes];
      const cursors = new Set<string>();
      while (connection.pageInfo.hasNextPage) {
        const cursor = connection.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Invalid inline comment pagination cursor.");
        cursors.add(cursor);
        const result = await runGh(
          pi,
          cwd,
          [
            "api",
            "--hostname",
            capability.hostname,
            "graphql",
            "-f",
            `query=${THREAD_COMMENTS_QUERY}`,
            "-f",
            `id=${thread.id}`,
            "-f",
            `endCursor=${cursor}`,
          ],
          signal,
        );
        if (result.code !== 0) throw new Error(`Unable to load inline thread comments: ${resultText(result)}`);
        const next = JSON.parse(result.stdout) as {
          errors?: unknown[];
          data?: { node?: { comments?: CommentConnection } };
        } | null;
        if (next?.errors?.length) throw new Error("Unable to load inline thread comments from GitHub.");
        connection = validateCommentConnection(next?.data?.node?.comments);
        comments.push(...connection.nodes);
      }
      threads.push({
        ...thread,
        comments: comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          author: comment.author?.login,
          createdAt: comment.createdAt,
          url: comment.url,
        })),
        commentsPageTruncated: false,
      });
    }
  }
  return threads;
}

function normalizeIssueComments(comments: IssueComment[]) {
  return comments.map((comment) => ({
    id: comment.id,
    author: comment.author ?? "unknown",
    body: comment.body ?? "",
    createdAt: comment.createdAt ?? "",
    updatedAt: comment.updatedAt ?? "",
    url: comment.url ?? "",
  }));
}

function normalizeReviews(reviews: Review[]) {
  return reviews.map((review) => ({
    id: review.id,
    author: review.author ?? "unknown",
    state: review.state ?? "",
    body: review.body ?? "",
    submittedAt: review.submittedAt ?? "",
    commitId: review.commitId ?? "",
    url: review.url ?? "",
  }));
}

function normalizeThreads(threads: ReviewThread[], includeResolved: boolean) {
  return threads
    .filter((thread) => includeResolved || !thread.isResolved)
    .map((thread) => ({
      id: thread.id,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      path: thread.path ?? "",
      line: thread.line ?? null,
      startLine: thread.startLine ?? null,
      originalLine: thread.originalLine ?? null,
      originalStartLine: thread.originalStartLine ?? null,
      diffSide: thread.diffSide ?? null,
      startDiffSide: thread.startDiffSide ?? null,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        body: comment.body ?? "",
        author: comment.author ?? "unknown",
        createdAt: comment.createdAt ?? "",
        url: comment.url ?? "",
      })),
      commentsTruncated: thread.commentsPageTruncated ?? false,
    }));
}

export async function getFeedback(
  pi: ExtensionAPI,
  cwd: string,
  capability: Extract<Capability, { available: true }>,
  pullRequest: PullRequest,
  includeResolved: boolean,
  signal?: AbortSignal,
) {
  const endpoint = `repos/${capability.owner}/${capability.repository}`;
  const [conversationResult, reviewsResult, threadsResult] = await Promise.all([
    runGh(
      pi,
      cwd,
      [
        "api",
        "--hostname",
        capability.hostname,
        "--paginate",
        "--jq",
        'map({id,author:(.user.login // "unknown"),body,createdAt:.created_at,updatedAt:.updated_at,url:.html_url})',
        `${endpoint}/issues/${pullRequest.number}/comments`,
      ],
      signal,
    ),
    runGh(
      pi,
      cwd,
      [
        "api",
        "--hostname",
        capability.hostname,
        "--paginate",
        "--jq",
        'map({id,author:(.user.login // "unknown"),body,state,submittedAt:.submitted_at,commitId:.commit_id,url:.html_url})',
        `${endpoint}/pulls/${pullRequest.number}/reviews`,
      ],
      signal,
    ),
    runGh(
      pi,
      cwd,
      [
        "api",
        "--hostname",
        capability.hostname,
        "--paginate",
        "--slurp",
        "graphql",
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
        "-F",
        `owner=${capability.owner}`,
        "-F",
        `repo=${capability.repository}`,
        "-F",
        `number=${pullRequest.number}`,
      ],
      signal,
    ),
  ]);

  const errors: string[] = [];
  let issueComments: IssueComment[] = [];
  let reviews: Review[] = [];
  let threads: ReviewThread[] = [];

  if (conversationResult.code === 0) {
    try {
      issueComments = parsePaginatedArray(conversationResult.stdout) as IssueComment[];
    } catch {
      errors.push("GitHub returned invalid conversation comment data.");
    }
  } else {
    errors.push(`Conversation comments could not be loaded: ${resultText(conversationResult)}`);
  }

  if (reviewsResult.code === 0) {
    try {
      reviews = parsePaginatedArray(reviewsResult.stdout) as Review[];
    } catch {
      errors.push("GitHub returned invalid review data.");
    }
  } else {
    errors.push(`Reviews could not be loaded: ${resultText(reviewsResult)}`);
  }

  if (threadsResult.code === 0) {
    try {
      threads = await parseReviewThreadPages(pi, cwd, capability, threadsResult.stdout, signal);
    } catch {
      errors.push("GitHub returned invalid inline review thread data.");
    }
  } else {
    errors.push(`Inline review threads could not be loaded: ${resultText(threadsResult)}`);
  }

  const unresolvedThreads = threads.filter((thread) => !thread.isResolved).length;
  const resolvedThreads = threads.length - unresolvedThreads;
  const outdatedThreads = threads.filter((thread) => thread.isOutdated).length;

  return {
    pullRequest: pullRequestSummary(pullRequest, capability),
    includeResolved,
    summary: {
      conversationComments: issueComments.length,
      reviews: reviews.length,
      inlineThreads: threads.length,
      unresolvedThreads,
      resolvedThreads,
      outdatedThreads,
      returnedThreads: includeResolved ? threads.length : unresolvedThreads,
    },
    conversationComments: normalizeIssueComments(issueComments),
    reviews: normalizeReviews(reviews),
    inlineThreads: normalizeThreads(threads, includeResolved),
    ...(errors.length > 0 ? { errors } : {}),
  };
}
