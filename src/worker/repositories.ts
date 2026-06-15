export function normalizeRepo(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}
