import {
  TerminalMessageType,
  TerminalSubscribeFlags,
  decodeJsonPayload,
  decodeTerminalFrame,
  encodeAckPayload,
  encodeResizePayload,
  encodeSubscribePayload,
  encodeTerminalFrame,
} from "../terminal-protocol.ts";
import { clipboardName, isTerminalReadyInteractiveSession, terminalText } from "./utils.js";

const terminalTheme = {
  background: "#101827",
  foreground: "#e5e7eb",
  cursor: "#f8fafc",
  selectionBackground: "#475569",
  selectionForeground: "#f8fafc",
  black: "#0f172a",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e5e7eb",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

let ghosttyModulePromise = null;
let terminalEpoch = 0;
let terminalHubSocket = null;
let terminalHubReconnectTimer = null;
let terminalHubOptions = {};
const terminalHosts = new Map();

export function configureTerminalHub(options) {
  terminalHubOptions = options;
}

export function warmGhosttyModule() {
  loadGhosttyModule().catch((error) => {
    console.warn("Ghostty preload failed", error);
  });
}

export async function mountTerminal(session, mount, options = {}) {
  const previous = terminalHosts.get(session.id);
  const text = terminalText(session);
  const live = shouldConnectLiveTerminal(session);
  const canInput = canSendTerminalInput(session);
  if (previous?.mount === mount && previous.live === live) {
    previous.focused = Boolean(options.focused);
    syncTerminalInputState(session, previous, previous.term);
    if (previous.live) {
      if (previous.terminalExited) {
        setTerminalStatus(session.id, previous.terminalExitLabel || "PTY exited");
        return;
      }
      if (!terminalHubSocket || terminalHubSocket.readyState >= WebSocket.CLOSING) {
        connectTerminalSocket(session, previous, previous.term);
      } else if (!previous.subscribed) {
        subscribeTerminalHost(session, previous, previous.term);
      }
      setTerminalStatus(
        session.id,
        terminalHubSocket?.readyState === WebSocket.OPEN
          ? previous.canInput
            ? "Live PTY"
            : "Read-only PTY"
          : "Connecting",
      );
      return;
    }
    if (previous.text !== text) {
      updateMountedTerminal(previous, text);
      previous.text = text;
    }
    setTerminalStatus(session.id, previous.term ? "Ghostty WASM" : "Text fallback");
    return;
  }

  disposeTerminal(session.id);
  const mountEpoch = terminalEpoch;
  try {
    const module = await loadGhosttyModule();
    if (isStaleTerminalMount(session, mount, mountEpoch)) return;
    if (!module?.Terminal) throw new Error("Ghostty module missing Terminal");
    mount.innerHTML = "";
    const term = new module.Terminal({
      disableStdin: !canInput,
      fontSize: options.focused ? 14 : 13,
      theme: terminalTheme,
    });
    const fit = module.FitAddon ? new module.FitAddon() : null;
    if (fit) term.loadAddon(fit);
    const restoreOpenScroll = preserveScrollPosition(mount);
    const previousActive = document.activeElement;
    term.open(mount);
    if (!options.focused) releaseTerminalFocus(mount, previousActive);
    restoreOpenScroll();
    if (!options.focused)
      requestAnimationFrame(() => {
        releaseTerminalFocus(mount, previousActive);
        restoreOpenScroll();
      });
    if (fit) {
      fit.fit();
      if (typeof fit.observeResize === "function") fit.observeResize();
    }
    const pasteHandler = (event) => handleTerminalPasteEvent(session.id, event);
    mount.addEventListener("paste", pasteHandler, { capture: true });
    if (!live) term.write(text);
    const host = {
      mount,
      term,
      fit,
      text,
      live,
      canInput,
      sessionId: session.id,
      focused: Boolean(options.focused),
      subscribed: false,
      dataSub: null,
      pasteHandler,
      colorQueryBuffer: "",
    };
    if (canInput && typeof term.onData === "function") {
      host.dataSub = term.onData((data) => sendTerminalInput(host, data));
    }
    terminalHosts.set(session.id, host);
    if (live) connectTerminalSocket(session, host, term);
    else setTerminalStatus(session.id, "Ghostty WASM");
  } catch (error) {
    if (isStaleTerminalMount(session, mount, mountEpoch)) return;
    mount.innerHTML = `<pre class="terminal-fallback"></pre>`;
    const fallback = mount.querySelector(".terminal-fallback");
    if (fallback) fallback.textContent = text;
    terminalHosts.set(session.id, { mount, term: null, text, live: false, socket: null });
    setTerminalStatus(session.id, "Text fallback");
    console.warn("Ghostty terminal unavailable", error);
  }
}

export function copyTerminalSelection(id) {
  const selection = terminalHosts.get(id)?.term?.getSelection?.() || "";
  if (!selection) {
    setTerminalStatus(id, "No selection");
    return;
  }
  navigator.clipboard
    ?.writeText(selection)
    .then(() => setTerminalStatus(id, "Copied"))
    .catch(() => setTerminalStatus(id, "Clipboard write blocked"));
}

export async function pasteClipboardText(id) {
  const host = terminalHosts.get(id);
  if (!host?.canInput) {
    setTerminalStatus(id, "Read-only PTY");
    return;
  }
  try {
    const text = await navigator.clipboard?.readText?.();
    if (!text) {
      setTerminalStatus(id, "Clipboard empty");
      return;
    }
    pasteTerminalText(host, text);
  } catch {
    setTerminalStatus(id, "Clipboard read blocked");
  }
}

export async function pasteClipboardFile(id) {
  const host = terminalHosts.get(id);
  if (!host?.canInput) {
    setTerminalStatus(id, "Read-only PTY");
    return;
  }
  if (!navigator.clipboard?.read) {
    setTerminalStatus(id, "Clipboard files unavailable");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type =
        item.types.find((value) => value.startsWith("image/")) ||
        item.types.find((value) => value !== "text/plain");
      if (type) {
        await uploadTerminalClipboardBlob(id, await item.getType(type), clipboardName(type), type);
        return;
      }
    }
    const text = await navigator.clipboard.readText();
    if (text) pasteTerminalText(host, text);
    else setTerminalStatus(id, "Clipboard empty");
  } catch {
    setTerminalStatus(id, "Clipboard read blocked");
  }
}

export function disposeMissingTerminals(ids) {
  for (const id of terminalHosts.keys()) {
    if (!ids.has(id)) disposeTerminal(id);
  }
}

export function disposeAllTerminals() {
  terminalEpoch += 1;
  disposeMissingTerminals(new Set());
}

export function disposeTerminal(id) {
  const host = terminalHosts.get(id);
  if (!host) return;
  const restoreScroll = preserveScrollPosition(host.mount);
  releaseTerminalFocus(host.mount);
  if (host.live && terminalHubSocket?.readyState === WebSocket.OPEN) {
    sendTerminalFrame(id, TerminalMessageType.Unsubscribe);
  }
  if (host.pasteHandler)
    host.mount?.removeEventListener("paste", host.pasteHandler, { capture: true });
  if (host.dataSub && typeof host.dataSub.dispose === "function") host.dataSub.dispose();
  if (host.fit && typeof host.fit.dispose === "function") host.fit.dispose();
  try {
    host.term?.dispose?.();
  } catch {}
  terminalHosts.delete(id);
  if (![...terminalHosts.values()].some((item) => item.live)) {
    if (terminalHubReconnectTimer) clearTimeout(terminalHubReconnectTimer);
    terminalHubReconnectTimer = null;
    if (terminalHubSocket?.readyState < WebSocket.CLOSING) {
      terminalHubSocket.close(1000, "no terminals mounted");
    }
  }
  restoreScroll();
}

function shouldConnectLiveTerminal(session) {
  return (
    isTerminalReadyInteractiveSession(session) &&
    (session.canControl === true ||
      session.sharedReadOnly === true ||
      (terminalHubOptions.sharedToken && session.id === terminalHubOptions.sharedSessionId))
  );
}

function canSendTerminalInput(session) {
  return (
    isTerminalReadyInteractiveSession(session) &&
    session.canControl === true &&
    session.sharedReadOnly !== true
  );
}

function terminalSocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/terminal/ws`);
  if (terminalHubOptions.sharedSessionId && terminalHubOptions.sharedToken) {
    url.searchParams.set("shareSession", terminalHubOptions.sharedSessionId);
    url.searchParams.set("token", terminalHubOptions.sharedToken);
  }
  return url.toString();
}

function connectTerminalSocket(session, host, term) {
  host.sessionId = session.id;
  syncTerminalInputState(session, host, term);
  host.live = true;
  ensureTerminalHub();
  subscribeTerminalHost(session, host, term);
}

function syncTerminalInputState(session, host, term) {
  const canInput = canSendTerminalInput(session);
  host.canInput = canInput;
  if (term?.options) term.options.disableStdin = !canInput;
  if (canInput && !host.dataSub && typeof term?.onData === "function") {
    host.dataSub = term.onData((data) => sendTerminalInput(host, data));
  }
  if (!canInput && host.dataSub) {
    if (typeof host.dataSub.dispose === "function") host.dataSub.dispose();
    host.dataSub = null;
  }
}

function ensureTerminalHub() {
  if (terminalHubSocket && terminalHubSocket.readyState < WebSocket.CLOSING) return;
  if (terminalHubReconnectTimer) {
    clearTimeout(terminalHubReconnectTimer);
    terminalHubReconnectTimer = null;
  }
  const socket = new WebSocket(terminalSocketUrl());
  socket.binaryType = "arraybuffer";
  terminalHubSocket = socket;
  for (const [id, host] of terminalHosts) {
    if (host.live) setTerminalStatus(id, "Connecting PTY");
  }
  socket.addEventListener("open", () => {
    sendTerminalFrame("", TerminalMessageType.Hello);
    for (const session of terminalHubOptions.sessions?.() || []) {
      const host = terminalHosts.get(session.id);
      if (host?.live && !host.terminalExited && shouldConnectLiveTerminal(session)) {
        subscribeTerminalHost(session, host, host.term);
      }
    }
  });
  socket.addEventListener("message", (event) => {
    terminalFrameBytes(event.data).then((bytes) => {
      const frame = decodeTerminalFrame(bytes);
      if (frame) handleTerminalHubFrame(frame);
    });
  });
  socket.addEventListener("close", (event) => {
    if (terminalHubSocket !== socket) return;
    for (const [id, host] of terminalHosts) {
      if (!host.live || host.terminalExited) continue;
      host.subscribed = false;
      const reason = event.reason || (event.code === 1000 ? "closed" : `closed ${event.code}`);
      setTerminalStatus(id, `PTY ${reason}`);
    }
    terminalHubSocket = null;
    if ([...terminalHosts.values()].some((host) => host.live && !host.terminalExited)) {
      terminalHubReconnectTimer = setTimeout(() => ensureTerminalHub(), 1500);
    }
  });
  socket.addEventListener("error", () => {
    if (terminalHubSocket !== socket) return;
    for (const [id, host] of terminalHosts) {
      if (host.live && !host.terminalExited) setTerminalStatus(id, "PTY error");
    }
  });
}

function subscribeTerminalHost(session, host, term) {
  if (!terminalHubSocket || terminalHubSocket.readyState !== WebSocket.OPEN) return;
  host.subscribed = true;
  const flags =
    TerminalSubscribeFlags.Output |
    TerminalSubscribeFlags.Snapshot |
    TerminalSubscribeFlags.Events |
    TerminalSubscribeFlags.OutputAcknowledgements;
  sendTerminalFrame(
    session.id,
    TerminalMessageType.Subscribe,
    encodeSubscribePayload({ flags, cols: term?.cols, rows: term?.rows }),
  );
  setTerminalStatus(session.id, "Connecting PTY");
}

async function terminalFrameBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(data);
}

function handleTerminalHubFrame(frame) {
  if (frame.type === TerminalMessageType.Welcome || frame.type === TerminalMessageType.Pong) return;
  const host = terminalHosts.get(frame.sessionId);
  if (!host) return;
  if (frame.type === TerminalMessageType.Output) {
    sendTerminalColorQueryResponses(host, frame.payload);
    host.term?.write(frame.payload);
    sendTerminalFrame(
      frame.sessionId,
      TerminalMessageType.Ack,
      encodeAckPayload(frame.payload.byteLength),
    );
    return;
  }
  const event = decodeJsonPayload(frame.payload);
  if (frame.type === TerminalMessageType.Error) {
    host.subscribed = false;
    const message = event?.error || "PTY error";
    const label = terminalErrorLabel(message);
    setTerminalStatus(frame.sessionId, label);
    if (isTerminalFinalError(message)) {
      host.terminalExited = true;
      host.terminalExitLabel = label;
    } else {
      scheduleTerminalResubscribe(frame.sessionId);
    }
    return;
  }
  if (frame.type === TerminalMessageType.ControlRevoked) {
    host.canInput = false;
    setTerminalStatus(frame.sessionId, "Read-only PTY");
    return;
  }
  if (frame.type !== TerminalMessageType.Event) return;
  if (event?.type === "subscribed") {
    setTerminalStatus(frame.sessionId, event.canInput ? "Live PTY" : "Read-only PTY");
    if (event.canInput && host.term?.cols && host.term?.rows) {
      sendTerminalFrame(
        frame.sessionId,
        TerminalMessageType.Resize,
        encodeResizePayload(host.term.cols, host.term.rows),
      );
      if (host.focused) focusTerminalWithoutScroll(host);
    }
  }
  if (event?.type === "ready") setTerminalStatus(frame.sessionId, terminalConnectedLabel(host));
  if (event?.type === "exit") {
    host.terminalExited = true;
    host.terminalExitLabel = `PTY ${event.type} ${event.code ?? ""}`.trim();
    setTerminalStatus(frame.sessionId, host.terminalExitLabel);
  }
  if (event?.type === "closed") {
    host.subscribed = false;
    host.terminalCloseLabel = `PTY closed ${event.code ?? ""}`.trim();
    if (!isTerminalPassiveClose(event.reason)) {
      host.terminalExited = true;
      host.terminalExitLabel = host.terminalCloseLabel;
    }
    setTerminalStatus(frame.sessionId, host.terminalCloseLabel);
  }
}

function handleTerminalPasteEvent(id, event) {
  const file = firstClipboardFile(event.clipboardData);
  if (!file) return;
  event.preventDefault();
  event.stopPropagation();
  uploadTerminalClipboardBlob(id, file, file.name || clipboardName(file.type));
}

function firstClipboardFile(data) {
  if (!data) return null;
  for (const file of Array.from(data.files || [])) {
    if (file && file.size > 0) return file;
  }
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.size > 0) return file;
  }
  return null;
}

async function uploadTerminalClipboardBlob(id, blob, name, mediaType = blob?.type || "") {
  const host = terminalHosts.get(id);
  if (!host?.canInput || terminalHubSocket?.readyState !== WebSocket.OPEN) {
    setTerminalStatus(id, "Live control required");
    return;
  }
  if (!canUploadTerminalClipboardFile(id)) {
    setTerminalStatus(id, "File paste requires Sandbox");
    return;
  }
  if (!blob || blob.size <= 0) {
    setTerminalStatus(id, "Clipboard empty");
    return;
  }
  if (blob.size > 10 * 1024 * 1024) {
    setTerminalStatus(id, "Clipboard file too large");
    return;
  }
  setTerminalStatus(id, `Uploading ${name || "clipboard"}`);
  const response = await fetch(`/api/interactive-sessions/${encodeURIComponent(id)}/clipboard`, {
    method: "POST",
    headers: {
      "content-type": mediaType || blob.type || "application/octet-stream",
      "x-clipboard-name": encodeURIComponent(name || clipboardName(mediaType)),
    },
    body: blob,
  });
  if (!response.ok) {
    setTerminalStatus(id, `Paste failed (${response.status})`);
    return;
  }
  const result = await response.json();
  const path = String(result.path || "");
  setTerminalStatus(id, path ? `Pasted ${result.name || "file"}` : "Paste done");
  if (path) pasteTerminalText(host, path);
}

function canUploadTerminalClipboardFile(id) {
  const session = (terminalHubOptions.sessions?.() || []).find(
    (item) => item.kind === "interactive" && item.id === id,
  );
  return (
    session?.canControl === true &&
    typeof session.leaseId === "string" &&
    session.leaseId.startsWith("sandbox:")
  );
}

function pasteTerminalText(host, text) {
  if (!host?.canInput) return;
  if (typeof host.term?.paste === "function") {
    host.term.paste(text);
    return;
  }
  sendTerminalInput(host, text);
}

export function terminalColorQueryResponses(data, theme = terminalTheme) {
  return terminalColorQueryState(data, "", theme).responses;
}

export function terminalColorQueryState(data, pending = "", theme = terminalTheme) {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const text = `${pending || ""}${
    typeof data === "string"
      ? data
      : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data))
  }`;
  if (!text.includes(`${escape}]1`)) {
    return { responses: [], pending: terminalColorQueryPrefix(text, escape) };
  }
  const responses = [];
  let offset = 0;
  let nextPending = "";
  for (;;) {
    const start = text.indexOf(`${escape}]1`, offset);
    if (start === -1) {
      nextPending = terminalColorQueryPrefix(text, escape);
      break;
    }
    if (text.length < start + 7) {
      nextPending = text.slice(start);
      break;
    }
    const code = text.slice(start + 2, start + 4);
    const query = text.slice(start + 4, start + 6);
    const terminator = text[start + 6];
    if ((code === "10" || code === "11") && query === ";?" && terminator === escape) {
      if (text.length < start + 8) {
        nextPending = text.slice(start);
        break;
      }
    }
    const stTerminator = terminator === escape && text[start + 7] === "\\";
    if (
      (code === "10" || code === "11") &&
      query === ";?" &&
      (terminator === bell || stTerminator)
    ) {
      const color = code === "10" ? theme.foreground : theme.background;
      responses.push(`${escape}]${code};${rgbResponse(color)}${bell}`);
      offset = start + (stTerminator ? 8 : 7);
      continue;
    }
    offset = start + 1;
  }
  return { responses, pending: nextPending.slice(-32) };
}

function sendTerminalColorQueryResponses(host, payload) {
  if (!host?.canInput) return;
  const result = terminalColorQueryState(payload, host.colorQueryBuffer);
  host.colorQueryBuffer = result.pending;
  for (const response of result.responses) {
    sendTerminalInput(host, response);
  }
}

function terminalColorQueryPrefix(text, escape) {
  const marker = `${escape}]1`;
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (marker.startsWith(suffix)) return suffix;
  }
  return "";
}

function rgbResponse(color) {
  const normalized = String(color || "").trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(normalized);
  if (!match) return "rgb:e5e5/e7e7/ebeb";
  const hex = match[1];
  return `rgb:${hex.slice(0, 2).repeat(2)}/${hex.slice(2, 4).repeat(2)}/${hex
    .slice(4, 6)
    .repeat(2)}`;
}

function scheduleTerminalResubscribe(id) {
  setTimeout(() => {
    const host = terminalHosts.get(id);
    const session = (terminalHubOptions.sessions?.() || []).find((item) => item.id === id);
    if (
      host?.live &&
      !host.subscribed &&
      !host.terminalExited &&
      session?.kind === "interactive" &&
      shouldConnectLiveTerminal(session) &&
      terminalHubSocket?.readyState === WebSocket.OPEN
    ) {
      subscribeTerminalHost(session, host, host.term);
    }
  }, 1500);
}

function isTerminalFinalError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("revoked") ||
    text.includes("session is stopped") ||
    text.includes("session is expired") ||
    text.includes("session is failed") ||
    text.includes("upstream terminal error") ||
    text.includes("terminal upstream") ||
    text.includes("terminal unavailable") ||
    text.includes("sandbox terminal") ||
    text.includes("not configured")
  );
}

function terminalErrorLabel(message) {
  return isTerminalFinalError(message) ? "PTY unavailable" : String(message || "PTY error");
}

function isTerminalPassiveClose(reason) {
  return ["unsubscribed", "client closed", "no terminals mounted"].includes(String(reason || ""));
}

function terminalConnectedLabel(host) {
  return host?.canInput ? "Live PTY" : "Read-only PTY";
}

function releaseTerminalFocus(mount, fallback) {
  if (!mount?.contains?.(document.activeElement)) return;
  try {
    document.activeElement?.blur?.();
    if (fallback && fallback !== document.body && !mount.contains(fallback)) {
      fallback.focus?.({ preventScroll: true });
    }
  } catch {}
}

function preserveScrollPosition(mount) {
  const scrollRoot = mount?.closest?.(".panel-body");
  const windowX = window.scrollX;
  const windowY = window.scrollY;
  const rootTop = scrollRoot?.scrollTop;
  const rootLeft = scrollRoot?.scrollLeft;
  return () => {
    if (scrollRoot && rootTop !== undefined && rootLeft !== undefined) {
      scrollRoot.scrollTop = rootTop;
      scrollRoot.scrollLeft = rootLeft;
    }
    window.scrollTo(windowX, windowY);
  };
}

function focusTerminalWithoutScroll(host) {
  const restoreScroll = preserveScrollPosition(host.mount);
  try {
    host.term?.focus?.();
  } catch {}
  restoreScroll();
  requestAnimationFrame(restoreScroll);
}

function sendTerminalInput(host, data) {
  if (!host.canInput || terminalHubSocket?.readyState !== WebSocket.OPEN) return;
  const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
  sendTerminalFrame(host.sessionId, TerminalMessageType.Input, payload);
}

function sendTerminalFrame(sessionId, type, payload = new Uint8Array()) {
  if (terminalHubSocket?.readyState === WebSocket.OPEN) {
    terminalHubSocket.send(encodeTerminalFrame({ type, sessionId, payload }));
  }
}

function isStaleTerminalMount(session, mount, mountEpoch) {
  return (
    mountEpoch !== terminalEpoch ||
    !mount.isConnected ||
    mount.dataset.sessionId !== session.id ||
    !mount.closest(".drawer.open")
  );
}

function updateMountedTerminal(host, text) {
  if (host.term) {
    const delta = text.startsWith(host.text)
      ? text.slice(host.text.length)
      : `\x1b[2J\x1b[H${text}`;
    if (delta) host.term.write(delta);
    return;
  }
  const fallback = host.mount.querySelector(".terminal-fallback");
  if (fallback) {
    fallback.textContent = text;
    return;
  }
  host.mount.innerHTML = `<pre class="terminal-fallback"></pre>`;
  host.mount.querySelector(".terminal-fallback").textContent = text;
}

function loadGhosttyModule() {
  ghosttyModulePromise ||= import("/vendor/ghostty-web.js").then(async (module) => {
    if (typeof module.init === "function") await module.init();
    return module;
  });
  return ghosttyModulePromise;
}

function setTerminalStatus(id, label) {
  terminalHubOptions.onStatus?.(id, label);
}
