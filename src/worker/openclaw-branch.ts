import { openClawServiceBranch } from "./openclaw-create.ts";
import { GitHubApiError, githubFetch, githubHeaders, type Fetcher } from "./github.ts";
import { badRequest } from "./http.ts";
import { githubRepoParts, normalizeRepo } from "./repositories.ts";

export type OpenClawBranchServiceDependencies = {
  token: string | undefined;
  requireRepo(repo: string): Promise<void>;
  fetcher?: Fetcher;
};

export class OpenClawBranchService {
  private readonly dependencies: OpenClawBranchServiceDependencies;

  constructor(dependencies: OpenClawBranchServiceDependencies) {
    this.dependencies = dependencies;
  }

  async ensure(
    repoInput: unknown,
    branchInput: unknown,
    baseBranchInput: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const repo = normalizeRepo(repoInput);
    if (!repo) throw badRequest("repo is required");
    const target = githubRepoParts(repo);
    if (!target) throw badRequest("repo must be a GitHub owner/name");
    await this.dependencies.requireRepo(repo);

    const branch = openClawServiceBranch(branchInput, "branch", "main");
    const baseBranch = openClawServiceBranch(baseBranchInput, "baseBranch");
    if (!baseBranch || branch === baseBranch || !this.dependencies.token) return;

    const { owner, name } = target;
    try {
      await this.readRef(owner, name, branch, signal);
      return;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }

    const baseSha = await this.readRef(owner, name, baseBranch, signal);
    try {
      await this.createRef(owner, name, branch, baseSha, signal);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      await this.readRef(owner, name, branch, signal);
    }
  }

  private async readRef(
    owner: string,
    name: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await githubFetch<{ object: { sha: string } }>(
      `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
      this.dependencies.token as string,
      signal,
      this.dependencies.fetcher,
    );
    return result.object.sha;
  }

  private async createRef(
    owner: string,
    name: string,
    branch: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await (this.dependencies.fetcher ?? fetch)(
      `https://api.github.com/repos/${owner}/${name}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
        headers: {
          ...githubHeaders(),
          authorization: `Bearer ${this.dependencies.token}`,
        },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw new GitHubApiError(response.status);
  }
}
