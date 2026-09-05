import type { Fetcher } from "./github.ts";
import { badRequest, serviceUnavailable } from "./http.ts";
import { sortRepoNames, sortRepos } from "./repositories.ts";

type GitHubIssuePayload = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  updated_at: string;
  pull_request?: unknown;
};

type GitHubGraphqlRefPayload = {
  __typename: "Issue" | "PullRequest";
  number: number;
  title: string;
  state: string;
  url: string;
  body: string | null;
  author: { login: string } | null;
  updatedAt: string;
};

export type GitHubReference = {
  repo: string;
  number: number;
  title: string;
  source: "Issue" | "PR";
  state: string;
  url: string;
  author: string | null;
  updatedAt: string;
  body: string;
};

export type GitHubReferenceServiceDependencies = {
  readEnabledRepos(): Promise<string[]>;
  preferredRepo: string;
  authenticated: boolean;
  headers: HeadersInit;
  fetcher: Fetcher;
};

export class GitHubReferenceService {
  private readonly dependencies: GitHubReferenceServiceDependencies;

  constructor(dependencies: GitHubReferenceServiceDependencies) {
    this.dependencies = dependencies;
  }

  async search(value: unknown): Promise<{ matches: GitHubReference[] }> {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
      throw badRequest("issue or PR number is required");
    }

    const repos = sortRepos(
      await this.dependencies.readEnabledRepos(),
      this.dependencies.preferredRepo,
    ).slice(0, 160);
    const matches = this.dependencies.authenticated
      ? await this.fetchAuthenticated(repos, number)
      : await this.fetchPublic(repos, number);
    return { matches };
  }

  private async fetchAuthenticated(repos: string[], number: number): Promise<GitHubReference[]> {
    const targets = repos.flatMap((repo) => {
      const [owner, name] = repo.split("/");
      return owner && name ? [{ repo, owner, name }] : [];
    });
    if (!targets.length) return [];
    const selections = targets
      .map(
        ({ owner, name }, index) => `r${index}: repository(owner: ${JSON.stringify(
          owner,
        )}, name: ${JSON.stringify(name)}) {
        issueOrPullRequest(number: $number) {
          __typename
          ... on Issue { number title state url body author { login } updatedAt }
          ... on PullRequest { number title state url body author { login } updatedAt }
        }
      }`,
      )
      .join("\n");
    const response = await this.dependencies.fetcher("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        ...this.dependencies.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `query CrabfleetRefs($number: Int!) { ${selections} }`,
        variables: { number },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 403 || response.status === 429) {
      throw serviceUnavailable("GitHub lookup rate limited; retry later");
    }
    if (!response.ok) throw serviceUnavailable("GitHub lookup failed; retry later");

    const payload = (await response.json()) as {
      data?: Record<string, { issueOrPullRequest?: GitHubGraphqlRefPayload | null } | null>;
      errors?: { type?: string; message?: string }[];
    };
    if (
      payload.errors?.some((error) =>
        /rate|limit/i.test(`${error.type ?? ""} ${error.message ?? ""}`),
      )
    ) {
      throw serviceUnavailable("GitHub lookup rate limited; retry later");
    }
    return targets
      .flatMap((target, index) => {
        const item = payload.data?.[`r${index}`]?.issueOrPullRequest;
        return item ? [referenceFromGraphql(target.repo, item)] : [];
      })
      .sort((left, right) => sortRepoNames(left.repo, right.repo, this.dependencies.preferredRepo));
  }

  private async fetchPublic(repos: string[], number: number): Promise<GitHubReference[]> {
    const repo = repos.includes(this.dependencies.preferredRepo)
      ? this.dependencies.preferredRepo
      : repos[0];
    if (!repo) return [];
    const response = await this.dependencies.fetcher(
      `https://api.github.com/repos/${repo}/issues/${number}`,
      { headers: this.dependencies.headers, signal: AbortSignal.timeout(10_000) },
    );
    if (response.status === 404 || response.status === 410) return [];
    if (response.status === 403 || response.status === 429) {
      throw serviceUnavailable("GitHub search rate limited; retry later");
    }
    if (!response.ok) return [];

    const item = (await response.json()) as GitHubIssuePayload;
    return [
      {
        repo,
        number: item.number,
        title: item.title,
        source: item.pull_request ? "PR" : "Issue",
        state: item.state,
        url: item.html_url,
        author: item.user?.login ?? null,
        updatedAt: item.updated_at,
        body: item.body ?? "",
      },
    ];
  }
}

function referenceFromGraphql(repo: string, item: GitHubGraphqlRefPayload): GitHubReference {
  return {
    repo,
    number: item.number,
    title: item.title,
    source: item.__typename === "PullRequest" ? "PR" : "Issue",
    state: item.state.toLowerCase(),
    url: item.url,
    author: item.author?.login ?? null,
    updatedAt: item.updatedAt,
    body: item.body ?? "",
  };
}
