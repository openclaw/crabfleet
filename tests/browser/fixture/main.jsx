import { render } from "preact";
import { act } from "preact/test-utils";
import { DesktopViewer } from "../../../src/app/desktop-viewer.jsx";
import "../../../src/app/style.css";
import "../../../src/app/desktop-viewer.css";
import { deferred, state, request } from "./state.js";

window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  readyState = 0;

  constructor(url) {
    super();
    this.host = decodeURIComponent(new URL(url).pathname.split("/")[3]);
    state.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send() {}

  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close"));
  }
};

Object.defineProperty(navigator, "clipboard", {
  value: {
    readText: () => request("read", state.clients.at(-1).host),
    writeText: (text) => request("write", state.clients.at(-1).host, text),
  },
});

const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  state.exportedFiles++;
  return createObjectURL(blob);
};

const startInterval = window.setInterval.bind(window);
const stopInterval = window.clearInterval.bind(window);
window.setInterval = (callback, delay) => {
  const timer = startInterval(callback, delay);
  state.intervals.add(timer);
  return timer;
};
window.clearInterval = (timer) => {
  state.intervals.delete(timer);
  stopInterval(timer);
};

const createBitmap = window.createImageBitmap.bind(window);
window.createImageBitmap = (...args) => {
  const pending = state.nextBitmap;
  state.nextBitmap = null;
  return pending ? pending.promise : createBitmap(...args);
};

const rootEntries = [
  { name: "First", isDirectory: true, size: 0 },
  { name: "Second", isDirectory: true, size: 0 },
  { name: "example.txt", isDirectory: false, size: 12 },
];

function client(host) {
  const result = state.clients.find((entry) => entry.host === host);
  if (!result) throw new Error(`No fixture client for ${host}`);
  return result;
}

async function complete({ kind, host = "first", path, value, error }) {
  const pending = state.requests.find(
    (entry) =>
      !entry.settled &&
      entry.kind === kind &&
      entry.host === host &&
      (path === undefined || entry.path === path),
  );
  if (!pending) throw new Error(`No pending ${kind} for ${host}: ${path ?? "any path"}`);
  pending.settled = true;
  await act(async () => {
    if (error) pending.reject(new Error(error));
    else pending.resolve(kind === "download" ? new Blob(["Synthetic file"]) : value);
    await Promise.resolve();
  });
}

export const viewerTest = {
  async connect(host, media = false) {
    state.media = media;
    state.nextReady = deferred();
    await act(() =>
      render(
        <DesktopViewer host={{ id: host, name: `Desktop ${host}` }} onExit={() => {}} />,
        document.getElementById("app"),
      ),
    );
    await state.nextReady.promise;
    await complete({ kind: "list", host, path: "", value: rootEntries });
  },

  complete,

  pending(kind) {
    return state.requests
      .filter((entry) => !entry.settled && entry.kind === kind)
      .map(({ host, path }) => ({ host, path }));
  },

  summary() {
    return {
      exportedFiles: state.exportedFiles,
      uploads: state.requests.filter((entry) => entry.kind === "upload").length,
      quality: state.clients.at(-1)?.quality,
      closedMedia:
        state.players.every((player) => player.closed) &&
        state.decoders.every((decoder) => decoder.closed),
      closedSockets: state.sockets.every((socket) => socket.readyState === 3),
      activeIntervals: state.intervals.size,
      players: state.players.map(({ closed, muted }) => ({ closed, muted })),
    };
  },

  receiveClipboard(host, text) {
    void client(host).callbacks.onClipboard(text);
  },

  async fail(host) {
    await act(async () => {
      client(host).finished.reject(new Error("Synthetic connection failed"));
      await Promise.resolve();
    });
  },

  async beginFrame(host, name, color) {
    const surface = new OffscreenCanvas(8, 8);
    const context = surface.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, 8, 8);
    const bitmap = await createBitmap(surface);
    const close = bitmap.close.bind(bitmap);
    const frame = { bitmap, pending: deferred(), closed: false };
    bitmap.close = () => {
      frame.closed = true;
      close();
    };
    state.nextBitmap = frame.pending;
    frame.completion = client(host).callbacks.onFrame({
      encoding: "jpeg",
      payload: new Uint8Array(),
    });
    state.frames.set(name, frame);
  },

  async finishFrame(name) {
    const frame = state.frames.get(name);
    frame.pending.resolve(frame.bitmap);
    await act(async () => await frame.completion);
    const canvas = document.querySelector("canvas");
    return {
      closed: frame.closed,
      pixel: [
        ...canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ],
    };
  },
};

window.viewerTest = viewerTest;
