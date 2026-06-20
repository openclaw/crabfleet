export const lucideIconNames = [
  "book-open",
  "check",
  "copy",
  "git-pull-request",
  "layout-grid",
  "link-2",
  "moon",
  "settings",
  "square-terminal",
  "sun",
  "terminal",
  "triangle-alert",
  "user-plus",
  "x",
];

export function buildLucideIconScript(iconNodes) {
  const selected = Object.fromEntries(lucideIconNames.map((name) => [name, iconNodes[name]]));
  return `(() => {
  globalThis.lucideIconNodes = ${JSON.stringify(selected)};
})();`;
}
