export function preferredEnabledRepo(repos: string[], preferred: string): string | undefined {
  return repos.includes(preferred) ? preferred : repos[0];
}
