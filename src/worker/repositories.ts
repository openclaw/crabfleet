export function normalizeRepo(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

export function githubRepoParts(repo: string): { owner: string; name: string } | null {
  const parts = repo.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (
    !owner ||
    !name ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner) ||
    !/^[a-z0-9._-]{1,100}$/i.test(name)
  ) {
    return null;
  }
  return { owner, name };
}

export function sortRepos(repos: string[], preferred: string): string[] {
  return [...repos].sort((left, right) => sortRepoNames(left, right, preferred));
}

export function sortRepoNames(left: string, right: string, preferred: string): number {
  if (left === preferred) return -1;
  if (right === preferred) return 1;
  return left.localeCompare(right);
}
