import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("app actions use styled HTML dialogs instead of browser prompts", async () => {
  const source = await readFile(new URL("../src/app/main.jsx", import.meta.url), "utf8");
  const appData = await readFile(new URL("../src/app/app-data.js", import.meta.url), "utf8");
  const appMutations = await readFile(
    new URL("../src/app/app-mutations.js", import.meta.url),
    "utf8",
  );
  const appShell = await readFile(new URL("../src/app/app-shell.jsx", import.meta.url), "utf8");
  const adminDrawer = await readFile(
    new URL("../src/app/admin-drawer.jsx", import.meta.url),
    "utf8",
  );
  const dialogs = await readFile(new URL("../src/app/dialogs.jsx", import.meta.url), "utf8");
  const login = await readFile(new URL("../src/app/login.jsx", import.meta.url), "utf8");
  const sessionWorkspace = await readFile(
    new URL("../src/app/session-workspace.jsx", import.meta.url),
    "utf8",
  );
  const workDrawers = await readFile(
    new URL("../src/app/work-drawers.jsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(appData, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(appMutations, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(appShell, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(adminDrawer, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(dialogs, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(login, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(sessionWorkspace, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(workDrawers, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.match(dialogs, /<dialog/);
  assert.match(dialogs, /showModal\(\)/);
  assert.match(dialogs, /function Drawer[\s\S]*?<dialog[\s\S]*?aria-labelledby=\{titleId\}/);
  assert.match(dialogs, /function Drawer[\s\S]*?previousFocus\?\.focus\?\.\(\)/);
  assert.match(dialogs, /dialog\.kind === "access"/);
  assert.match(dialogs, /name="principal"/);
  assert.match(dialogs, /void revokeGrant\(grant\.subject\)/);
  assert.match(workDrawers, /defaults\.profiles\.map\(\(profile\) =>/);
  assert.match(workDrawers, /runtimeProfileOptionLabel\(profile\)/);
  assert.match(workDrawers, /onReset=\{\(\) => setRuntime\(defaults\.runtime\)\}/);
  assert.match(adminDrawer, /useEffect\(\(\) => setRepo\(preferred\), \[preferred\]\)/);
  assert.match(sessionWorkspace, /const canManage = Boolean\(session\.canManage\)/);
  assert.doesNotMatch(sessionWorkspace, /session\.canManage \|\| canMaintain/);
  assert.match(sessionWorkspace, /manageInteractiveSessionAccess\(session\.id\)/);
  assert.match(
    sessionWorkspace,
    /props\.minimal[\s\S]*?!session\.sharedLinkOnly && !session\.sharedReadOnly[\s\S]*?Logs/,
  );
  assert.match(sessionWorkspace, /Codex CLI terminals with explicit sharing controls\./);
  assert.doesNotMatch(sessionWorkspace, /Private Codex CLI terminals/);
});

test("fleet terminal affordances require attachable session state", async () => {
  const source = await readFile(new URL("../src/app/fleet.jsx", import.meta.url), "utf8");

  assert.match(source, /const attachable = isFleetSessionAttachable\(session\)/);
  assert.match(source, /\{attachable \? \(/);
  assert.match(source, /cli=\{totals\.attachable \?\? props\.cli\}/);
});

test("workspace deletion remains available from Fleet", async () => {
  const fleet = await readFile(new URL("../src/app/fleet.jsx", import.meta.url), "utf8");

  assert.match(fleet, /!String\(session\.id\)\.startsWith\("LOCAL-"\)/);
  assert.match(fleet, /canManage && actionable/);
  assert.match(fleet, /const endLabel = ending/);
  assert.match(fleet, /deleteInteractiveSession\(session\.id\)/);
});

test("mobile navigation and access dialogs stay inside the viewport", async () => {
  const html = await readFile(new URL("../src/app.html", import.meta.url), "utf8");

  assert.match(
    html,
    /@media \(max-width: 720px\)[\s\S]*?\.nav-actions \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?width: 100%;/,
  );
  assert.match(
    html,
    /@media \(max-width: 720px\)[\s\S]*?\.action-dialog \{[\s\S]*?width: calc\(100vw - 20px\);/,
  );
  assert.match(
    html,
    /@media \(max-width: 720px\)[\s\S]*?\.action-dialog-access-form \{[\s\S]*?grid-template-columns: 1fr;/,
  );
});
