import type { RuntimeEnv } from "./env.ts";
import type { User } from "./models.ts";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GitHubUserRefreshEvidence = {
  user: User | null;
  emailLookupComplete: boolean;
};

type GitHubProfile = {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
};

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub API failed: ${status}`);
    this.status = status;
  }
}

export async function githubFetch<T>(
  path: string,
  token: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: {
      ...githubHeaders(),
      authorization: `Bearer ${token}`,
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new GitHubApiError(response.status);
  return response.json<T>();
}

export function githubHeaders(env?: Pick<RuntimeEnv, "GITHUB_TOKEN">): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    ...(env?.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    "user-agent": "crabbox-ai",
    "x-github-api-version": "2022-11-28",
  };
}

export async function githubFetchPages<T>(
  path: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubFetch<T[]>(
      `${path}${separator}per_page=100&page=${page}`,
      token,
      undefined,
      fetcher,
    );
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

export async function fetchGithubRepoNodeId(
  repo: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const response = await fetcher(`https://api.github.com/repos/${repo}`, {
    headers: {
      ...githubHeaders(),
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub repository metadata lookup failed for ${repo}`);
  }
  const body = (await response.json()) as { node_id?: unknown };
  if (typeof body.node_id !== "string" || !body.node_id) {
    throw new Error(`GitHub repository metadata lookup did not include node_id for ${repo}`);
  }
  return body.node_id;
}

export async function githubNodeBelongsToRepo(
  nodeId: string,
  repo: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  const [owner, name] = repo.toLowerCase().split("/");
  if (!owner || !name) return false;
  const response = await fetcher("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: `query($id: ID!) {
        node(id: $id) {
          __typename
          ... on Repository {
            owner { login }
            name
          }
          ... on RepositoryNode {
            repository { owner { login } name }
          }
        }
      }`,
      variables: { id: nodeId },
    }),
    headers: {
      ...githubHeaders(),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as {
    data?: {
      node?: {
        name?: unknown;
        owner?: { login?: unknown };
        repository?: { name?: unknown; owner?: { login?: unknown } };
      };
    };
    errors?: unknown;
  } | null;
  if (!body || body.errors) return false;
  const node = body.data?.node;
  const repository = node?.repository ?? node;
  return (
    typeof repository?.owner?.login === "string" &&
    typeof repository.name === "string" &&
    repository.owner.login.toLowerCase() === owner &&
    repository.name.toLowerCase() === name
  );
}

export async function refreshGitHubUser(
  env: RuntimeEnv,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<User | null> {
  return (await refreshGitHubUserWithEvidence(env, token, fetcher)).user;
}

export async function refreshGitHubUserWithEvidence(
  env: RuntimeEnv,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<GitHubUserRefreshEvidence> {
  const org = env.GITHUB_ORG ?? "openclaw";
  const [githubUser, emailLookup, membership, teamRows] = await Promise.all([
    githubFetch<GitHubProfile>("/user", token, undefined, fetcher),
    githubFetch<Array<{ email: string; primary: boolean; verified: boolean }>>(
      "/user/emails",
      token,
      undefined,
      fetcher,
    )
      .then((emails) => ({ emails, complete: true }))
      .catch(() => ({ emails: [], complete: false })),
    githubFetch<{ state: string }>(
      `/user/memberships/orgs/${org}`,
      token,
      undefined,
      fetcher,
    ).catch((error) => {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }),
    githubFetchPages<{ slug: string; organization?: { login?: string } }>(
      "/user/teams",
      token,
      fetcher,
    ),
  ]);
  if (membership?.state !== "active") {
    return { user: null, emailLookupComplete: emailLookup.complete };
  }
  const email =
    githubUser.email ??
    emailLookup.emails.find((item) => item.primary && item.verified)?.email ??
    emailLookup.emails.find((item) => item.verified)?.email ??
    null;
  const teams = teamRows
    .filter((team) => (team.organization?.login ?? "").toLowerCase() === org.toLowerCase())
    .map((team) => `@${org}/${team.slug}`);
  return {
    user: {
      subject: `github:${githubUser.id}`,
      login: githubUser.login,
      email,
      name: githubUser.name,
      role: "viewer",
      allowed: false,
      teams,
    },
    emailLookupComplete: emailLookup.complete,
  };
}
