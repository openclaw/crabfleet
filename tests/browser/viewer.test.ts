import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite";

declare const window: { viewerTest: typeof import("./fixture/main.jsx").viewerTest };

const fixture = fileURLToPath(new URL("./fixture/", import.meta.url));
const file = (name: string) => ({ name, isDirectory: false, size: 12 });
type Completion = { kind: string; host?: string; path?: string; value?: unknown; error?: string };

describe("browser viewer", { timeout: 60_000 }, () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let server: PreviewServer;
  let output: string;
  let origin: string;
  let errors: string[];

  before(async () => {
    output = await mkdtemp(join(tmpdir(), "crabfleet-viewer-tests-"));
    await build({
      root: fixture,
      configFile: false,
      plugins: [preact()],
      resolve: {
        alias: [
          { find: /^\.\/rfb\/client\.ts$/, replacement: join(fixture, "client.js") },
          { find: /^\.\/rfb\/(audio|h264|hevc)\.ts$/, replacement: join(fixture, "media.js") },
        ],
      },
      build: { outDir: output, emptyOutDir: true },
      logLevel: "silent",
    });
    server = await preview({
      root: fixture,
      configFile: false,
      build: { outDir: output },
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
      logLevel: "silent",
    });
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    if (output) await rm(output, { recursive: true, force: true });
  });

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
  });

  afterEach(async () => {
    await context?.close();
    assert.deepEqual(errors, [], "the viewer must not raise unhandled browser errors");
  });

  async function open(media = false) {
    await page.goto(origin);
    await page.evaluate((media) => window.viewerTest.connect("first", media), media);
  }

  async function switchHost(media = false) {
    await page.evaluate((media) => window.viewerTest.connect("second", media), media);
  }

  async function complete(value: Completion) {
    await page.evaluate((value) => window.viewerTest.complete(value), value);
  }

  const pending = (kind: string) => page.evaluate((kind) => window.viewerTest.pending(kind), kind);
  const summary = () => page.evaluate(() => window.viewerTest.summary());
  const openFiles = () => page.getByRole("button", { name: /^Files ·/ }).click();
  const notice = () => page.locator(".desktop-clipboard span").textContent();
  const chooseFiles = (names: string[]) =>
    page.locator('input[type="file"]').setInputFiles(
      names.map((name) => ({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic file"),
      })),
    );

  async function newFolder() {
    page.once("dialog", (dialog) => void dialog.accept("new-folder"));
    await page.getByRole("button", { name: "New folder", exact: true }).click();
  }

  it("connects and changes quality when session storage is blocked", async () => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "sessionStorage", {
        get() {
          throw new DOMException("Storage blocked", "SecurityError");
        },
      });
    });
    await open();
    await page.getByRole("button", { name: "Sharp", exact: true }).click();
    assert.equal((await summary()).quality, "sharp");
    assert.equal(
      await page.getByRole("button", { name: "Sharp", exact: true }).getAttribute("aria-pressed"),
      "true",
    );
  });

  it("retains the latest requested folder when responses arrive out of order", async () => {
    await open();
    await openFiles();
    await page.getByRole("button", { name: /First/ }).click();
    await page.getByRole("button", { name: /Second/ }).click();
    await complete({ kind: "list", path: "Second", value: [file("second.txt")] });
    await complete({ kind: "list", path: "First", value: [file("first.txt")] });
    assert.equal(await page.locator(".desktop-file-panel header span").textContent(), "/Second");
    assert.match(await page.locator(".desktop-file-list").innerText(), /second.txt/);
  });

  it("closes a late bitmap without painting over the next desktop", async () => {
    await open();
    await page.evaluate(() => window.viewerTest.beginFrame("first", "old", "red"));
    await switchHost();
    await page.evaluate(() => window.viewerTest.beginFrame("second", "current", "blue"));
    await page.evaluate(() => window.viewerTest.finishFrame("current"));
    const result = await page.evaluate(() => window.viewerTest.finishFrame("old"));
    assert.equal(result.closed, true);
    assert.deepEqual(
      result.pixel,
      [0, 0, 255, 255],
      "the actual canvas must retain the current blue frame",
    );
  });

  it("stops an old upload batch and its refresh after changing desktops", async () => {
    await open();
    await openFiles();
    await chooseFiles(["one.txt", "two.txt"]);
    await switchHost();
    await complete({ kind: "upload" });
    assert.equal((await summary()).uploads, 1);
    assert.deepEqual(await pending("list"), []);
  });

  it("does not export a download completed by an old desktop", async () => {
    await open();
    await openFiles();
    await page.getByRole("button", { name: /example.txt/ }).click();
    await switchHost();
    await complete({ kind: "download" });
    assert.equal((await summary()).exportedFiles, 0);
  });

  it("does not refresh the next desktop after an old directory creation", async () => {
    await open();
    await openFiles();
    await newFolder();
    await switchHost();
    await complete({ kind: "mkdir" });
    assert.deepEqual(await pending("list"), []);
  });

  for (const kind of ["send", "read", "write"]) {
    it(`ignores late ${kind} clipboard completion after a desktop change`, async () => {
      await open();
      if (kind === "send") {
        await page.locator("textarea").fill("Synthetic clipboard");
        await page.getByRole("button", { name: "Send to desktop", exact: true }).click();
      } else if (kind === "read") {
        await page.getByRole("button", { name: "Load system clipboard", exact: true }).click();
      } else {
        await page.evaluate(() =>
          window.viewerTest.receiveClipboard("first", "Synthetic remote clipboard"),
        );
      }
      await switchHost();
      await complete({ kind, value: "Stale clipboard" });
      assert.equal(await page.locator("textarea").inputValue(), "");
      assert.equal(await notice(), "");
    });
  }

  it("does not unmute a closed player or change the next desktop's audio choice", async () => {
    await open(true);
    await page.getByRole("button", { name: "Unmute audio", exact: true }).click();
    await switchHost(true);
    await complete({ kind: "audio" });
    assert.equal(await page.getByRole("button", { name: "Unmute audio", exact: true }).count(), 1);
    assert.deepEqual((await summary()).players, [
      { closed: true, muted: true },
      { closed: false, muted: true },
    ]);
  });

  it("releases media, relay, and stats timer when a connection fails", async () => {
    await open(true);
    await page.evaluate(() => window.viewerTest.fail("first"));
    const result = await summary();
    assert.equal(result.closedMedia, true);
    assert.equal(result.closedSockets, true);
    assert.equal(result.activeIntervals, 0);
    assert.equal(
      await page.getByText("Synthetic connection failed", { exact: true }).innerText(),
      "Synthetic connection failed",
    );
  });

  for (const kind of ["upload", "mkdir"]) {
    it(`keeps later folder navigation when ${kind} completes on the same desktop`, async () => {
      await open();
      await openFiles();
      if (kind === "upload") await chooseFiles(["one.txt"]);
      else await newFolder();
      await page.getByRole("button", { name: /First/ }).click();
      await complete({ kind: "list", path: "First", value: [file("inside.txt")] });
      await complete({ kind });
      assert.deepEqual(await pending("list"), []);
      assert.equal(await page.locator(".desktop-file-panel header span").innerText(), "/First");
    });
  }

  it("preserves clipboard, download, directory and batch-upload success in the current session", async () => {
    await open();
    await page.locator("textarea").fill("Current clipboard");
    await page.getByRole("button", { name: "Send to desktop", exact: true }).click();
    await complete({ kind: "send" });
    assert.equal(await notice(), "Clipboard sent to desktop");
    await page.getByRole("button", { name: "Load system clipboard", exact: true }).click();
    await complete({ kind: "read", value: "Current local clipboard" });
    assert.equal(await page.locator("textarea").inputValue(), "Current local clipboard");
    await openFiles();
    await page.getByRole("button", { name: /example.txt/ }).click();
    await complete({ kind: "download" });
    assert.equal((await summary()).exportedFiles, 1);
    await newFolder();
    await complete({ kind: "mkdir" });
    await complete({ kind: "list", value: [file("created.txt")] });
    await chooseFiles(["one.txt", "two.txt"]);
    await complete({ kind: "upload", path: "one.txt" });
    await complete({ kind: "upload", path: "two.txt" });
    await complete({ kind: "list", value: [file("one.txt"), file("two.txt")] });
    assert.equal((await summary()).uploads, 2);
    assert.match(await page.locator(".desktop-file-list").innerText(), /two.txt/);
  });

  for (const width of [320, 390]) {
    it(`keeps toolbar and clipboard controls usable at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      await open();
      const layout = await page.evaluate(() => {
        const stage = document.querySelector(".desktop-viewer-stage")!.getBoundingClientRect();
        const picker = document.querySelector(".desktop-quality-picker")!.getBoundingClientRect();
        const inside = (element: Element, left: number, right: number, bottom: number) => {
          const box = element.getBoundingClientRect();
          return box.left >= left && box.right <= right && box.bottom <= bottom;
        };
        return {
          width: innerWidth,
          toolbar: [...document.querySelectorAll(".desktop-viewer-bar button")].every((element) =>
            inside(element, 0, innerWidth, stage.top),
          ),
          quality: [...document.querySelectorAll(".desktop-quality-picker button")].every(
            (element) => inside(element, picker.left, picker.right, stage.top),
          ),
          clipboard: [...document.querySelectorAll(".desktop-clipboard button")].every((element) =>
            inside(element, 0, innerWidth, innerHeight),
          ),
          textWidth: document.querySelector("textarea")!.getBoundingClientRect().width,
        };
      });
      assert.equal(layout.width, width);
      assert.equal(
        layout.toolbar,
        true,
        "toolbar buttons must not overflow or overlap the display",
      );
      assert.equal(
        layout.quality,
        true,
        "quality controls must not be clipped inside their picker",
      );
      assert.equal(layout.clipboard, true, "clipboard actions must remain in the viewport");
      assert.ok(layout.textWidth >= width / 2, "clipboard field must retain useful width");
    });
  }
});
