// Synthetic browser endpoint for the native adapter's optional interop test.
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
let stage = "startup";

(async () => {
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Local WebRTC fixture</title>");
  });
  let browser;
  const deadline = setTimeout(() => process.exit(1), 45000);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
      headless: true,
      chromiumSandbox: true,
    });
    stage = "page";
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const source = await fs.readFile(path.join(__dirname, "../../browser/test_peer.js"), "utf8");
    await page.addScriptTag({
      type: "module",
      content: source + "\nwindow.BrowserHost = BrowserHost;",
    });
    await page.evaluate(() => {
      window.host = new window.BrowserHost();
    });
    for await (const line of readline.createInterface({ input: process.stdin })) {
      if (line.length > 2 * 256 * 1024) throw new Error("Fixture request limit");
      const command = JSON.parse(line);
      if (command.startMedia) {
        stage = "start media";
        const media = page
          .evaluate(() => host.addMedia())
          .then(
            () => null,
            (error) => error,
          );
        await page
          .getByRole("button", { name: "Start silent WebRTC test audio" })
          .click({ timeout: 10000 });
        const error = await media;
        if (error) throw error;
      }
      if (command.close) {
        stage = "close media";
        const result = await page.evaluate(async () => {
          const stats = await host.rtc.getStats();
          const codecs = [...stats.values()]
            .filter((entry) => entry.type === "outbound-rtp" && entry.bytesSent > 0)
            .map((entry) => stats.get(entry.codecId)?.mimeType?.toLowerCase())
            .filter(Boolean);
          const profiles = [...stats.values()]
            .filter((entry) => entry.type === "transport")
            .map((entry) => entry.srtpCipher)
            .filter((value) => typeof value === "string" && /^SRTP_[A-Z0-9_]+$/.test(value));
          await host.close();
          const closed =
            host.rtc.connectionState === "closed" &&
            host.streams.every((stream) =>
              stream.getTracks().every((track) => track.readyState === "ended"),
            ) &&
            host.audio.state === "closed";
          return { ok: true, closed, codecs, profiles };
        });
        process.stdout.write(JSON.stringify(result) + "\n");
        continue;
      }
      stage = "signaling";
      const result = await page.evaluate(async ({ signals }) => {
        for (const signal of signals) {
          if (signal.description) {
            await host.accept(signal.description.type, signal.description.sdp);
          } else if (signal.candidate) {
            const c = signal.candidate;
            await host.candidate(c.candidate, c.sdpMLineIndex, c.sdpMid);
          }
        }
        return { ok: true, signals: host.takeSignals(), received: host.received.length };
      }, command);
      // Pipe-only signaling; the Rust test never prints payloads or SDP.
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } finally {
    clearTimeout(deadline);
    try {
      await browser?.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
})().catch((error) => {
  process.stdout.write('{"ok":false}\n');
  process.stderr.write(`Local browser fixture failed during ${stage} (${error.name})\n`);
  process.exitCode = 1;
});
