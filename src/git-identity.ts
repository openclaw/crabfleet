export function sandboxGitAuthorEmail(owner: string): string {
  const normalized = String(owner).trim().toLowerCase().slice(0, 320);
  if (/^[^@\s]+@[^@\s]+$/.test(normalized)) return normalized;
  const localPart = normalized
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return `${localPart || "crabfleet"}@users.noreply.github.com`;
}
