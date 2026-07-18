import { useEffect, useRef, useState } from "preact/hooks";
import { RemoteAudioPlayer, supportsWebCodecsAudio } from "./rfb/audio.ts";
import { RFBClient } from "./rfb/client.ts";
import { H264Decoder, supportsWebCodecsH264 } from "./rfb/h264.ts";
import { HEVCDecoder, supportsWebCodecsHEVC, supportsWebCodecsHEVCRExt } from "./rfb/hevc.ts";
import {
  keysymForKey,
  pointerButtonMask,
  pointerCoordinates,
  scrollButtonMask,
} from "./rfb/input.ts";
import { CanvasRenderer } from "./rfb/render.ts";
import { WebSocketByteStream } from "./rfb/stream.ts";
import { cursorCSS, remotePointerAfterCursorShape, shouldShowCursorOverlay } from "./rfb/cursor.ts";
import { ViewerStatsWindow } from "./rfb/stats.ts";
import { loadViewerQuality, saveViewerQuality } from "./rfb/quality.ts";
import { browserDirectRFBAuthentication as directRFBAuthentication } from "./rfb/browser-auth.ts";

export function desktopViewerHostID(pathname = location.pathname) {
  const match = pathname.match(/^\/app\/desktops\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function cursorDataURL(cursor) {
  if (cursor.rgba.byteLength !== cursor.width * cursor.height * 4)
    throw new Error("invalid browser cursor pixels");
  const canvas = document.createElement("canvas");
  canvas.width = cursor.width;
  canvas.height = cursor.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("cursor canvas is unavailable");
  const image = context.createImageData(cursor.width, cursor.height);
  for (let offset = 0; offset < cursor.rgba.byteLength; offset += 4) {
    const alpha = cursor.rgba[offset + 3];
    image.data[offset] = unpremultiply(cursor.rgba[offset], alpha);
    image.data[offset + 1] = unpremultiply(cursor.rgba[offset + 1], alpha);
    image.data[offset + 2] = unpremultiply(cursor.rgba[offset + 2], alpha);
    image.data[offset + 3] = alpha;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function unpremultiply(component, alpha) {
  if (!alpha) return 0;
  return Math.min(255, Math.round((component * 255) / alpha));
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function DesktopViewer({ host, onExit }) {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const sessionRef = useRef(null);
  const readyRef = useRef(false);
  const pressedKeysRef = useRef(new Map());
  const pointerRef = useRef({ x: 0, y: 0, buttonsDown: false });
  const pendingResizeRef = useRef(null);
  const audioRef = useRef(null);
  const uploadInputRef = useRef(null);
  const audioEnabledRef = useRef(false);
  const [connectionState, setConnectionState] = useState("Preparing decoder");
  const [serverName, setServerName] = useState(host?.name || host?.id || "Desktop");
  const [codec, setCodec] = useState("Detecting");
  const [stats, setStats] = useState({
    fps: 0,
    mbitPerSecond: 0,
    droppedAudio: 0,
    jitterMs: 0,
  });
  const [statsVisible, setStatsVisible] = useState(false);
  const [qualityMode, setQualityMode] = useState(() =>
    loadViewerQuality(sessionStorage, host?.id || "unknown"),
  );
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioMuted, setAudioMuted] = useState(true);
  const [manualClipboard, setManualClipboard] = useState("");
  const [clipboardNotice, setClipboardNotice] = useState("");
  const [cursorImage, setCursorImage] = useState(null);
  const [remotePointer, setRemotePointer] = useState(null);
  const [localPointer, setLocalPointer] = useState(null);
  const [hasPointerFocus, setHasPointerFocus] = useState(false);
  const [framebufferSize, setFramebufferSize] = useState({ width: 1, height: 1 });
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [fileSharing, setFileSharing] = useState(null);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [fileEntries, setFileEntries] = useState([]);
  const [fileStatus, setFileStatus] = useState("");
  const [fileProgress, setFileProgress] = useState(null);

  const noteLocalPointer = (point, convergedRemote = true) => {
    setLocalPointer(point);
    if (convergedRemote) setRemotePointer(point);
    setHasPointerFocus(true);
  };

  const releasePressedKeys = () => {
    const session = sessionRef.current;
    if (readyRef.current && session) {
      for (const keysym of pressedKeysRef.current.values()) {
        try {
          session.sendKey(false, keysym);
        } catch {}
      }
    }
    pressedKeysRef.current.clear();
  };

  const releasePointerButtons = () => {
    const pointer = pointerRef.current;
    if (pointer.buttonsDown && readyRef.current && sessionRef.current) {
      try {
        sessionRef.current.sendPointer(0, pointer.x, pointer.y);
      } catch {}
    }
    pointer.buttonsDown = false;
  };

  useEffect(() => {
    if (host?.id) setQualityMode(loadViewerQuality(sessionStorage, host.id));
  }, [host?.id]);

  useEffect(() => {
    const releaseInput = () => {
      releasePressedKeys();
      releasePointerButtons();
      setHasPointerFocus(false);
    };
    const restorePointerFocus = () =>
      setHasPointerFocus(Boolean(canvasRef.current?.matches(":hover")));
    window.addEventListener("blur", releaseInput);
    window.addEventListener("focus", restorePointerFocus);
    return () => {
      window.removeEventListener("blur", releaseInput);
      window.removeEventListener("focus", restorePointerFocus);
    };
  }, []);

  useEffect(() => {
    if (!host || !canvasRef.current) return undefined;
    audioEnabledRef.current = false;
    setAudioMuted(true);
    setAudioAvailable(false);
    setCursorImage(null);
    setRemotePointer(null);
    setLocalPointer(null);
    setHasPointerFocus(false);
    setFileSharing(null);
    setFilePanelOpen(false);
    setFilePath("");
    setFileEntries([]);
    setFileStatus("");
    setFileProgress(null);
    let disposed = false;
    let h264Decoder = null;
    let hevcDecoder = null;
    let client = null;
    const renderer = new CanvasRenderer(canvasRef.current);
    const statsWindow = new ViewerStatsWindow(performance.now());
    const socketProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${socketProtocol}//${location.host}/api/desktop-hosts/${encodeURIComponent(host.id)}/relay/viewer`,
    );
    const stream = new WebSocketByteStream(socket);

    const statsTimer = setInterval(() => {
      const snapshot = statsWindow.snapshot(performance.now());
      setStats((current) => ({ ...current, ...snapshot }));
    }, 250);

    const connect = async () => {
      const [hevc, h264, rext, audio] = await Promise.all([
        supportsWebCodecsHEVC(),
        supportsWebCodecsH264(),
        supportsWebCodecsHEVCRExt(),
        supportsWebCodecsAudio(),
      ]);
      if (disposed) return;
      setCodec(hevc ? "HEVC / WebCodecs" : h264 ? "H.264 / WebCodecs" : "JPEG / Tight");
      if (hevc) {
        hevcDecoder = new HEVCDecoder(
          async (frame) => {
            await renderer.present(frame);
            statsWindow.recordDecodedFrame(performance.now());
          },
          (error) => {
            if (client) client.reportDecoderFailure("hevc", error);
            else setConnectionState(`Decoder error: ${error.message}`);
          },
          () => client?.requestCodecRefresh(),
        );
      }
      if (h264) {
        h264Decoder = new H264Decoder(
          async (frame) => {
            await renderer.present(frame);
            statsWindow.recordDecodedFrame(performance.now());
          },
          (error) => {
            if (client) client.reportDecoderFailure("h264", error);
            else setConnectionState(`Decoder error: ${error.message}`);
          },
        );
      }
      if (audio) {
        const player = new RemoteAudioPlayer(
          (audioStats) =>
            setStats((current) => ({
              ...current,
              droppedAudio: audioStats.droppedPackets,
              jitterMs: audioStats.jitterDepthMs,
            })),
          (error) => setConnectionState(`Audio disabled: ${error.message}`),
        );
        audioRef.current = player;
        player.setMuted(true);
      }
      client = new RFBClient(stream, {
        // This component opens the owner-authenticated Worker relay. Direct
        // byte transports must await browserDirectRFBAuthentication first.
        hevc,
        h264,
        chroma444: hevc && rext,
        audio,
        qualityMode: loadViewerQuality(sessionStorage, host.id),
        onState: setConnectionState,
        onReady: () => {
          readyRef.current = true;
          const pending = pendingResizeRef.current;
          if (pending) sessionRef.current?.resize(pending.width, pending.height);
        },
        onServerInit: (info) => {
          setServerName(info.name);
          setCodec(
            info.codec === "HEVC"
              ? "HEVC / WebCodecs"
              : info.codec === "H.264"
                ? "H.264 / WebCodecs"
                : "JPEG / Tight",
          );
          setFramebufferSize({ width: info.width, height: info.height });
        },
        onResize: (width, height) => setFramebufferSize({ width, height }),
        onCursor: (cursor) => {
          const canvas = canvasRef.current;
          if (!canvas || !cursor) {
            if (canvas) canvas.style.cursor = "none";
            setCursorImage(null);
            setRemotePointer((current) => remotePointerAfterCursorShape(current, false));
            return;
          }
          const dataURL = cursorDataURL(cursor);
          setCursorImage({ ...cursor, dataURL });
        },
        onPointerPosition: setRemotePointer,
        onTraffic: (bytes) => {
          statsWindow.recordTraffic(bytes, performance.now());
        },
        onFrame: async (frame) => {
          if (frame.encoding === "hevc") {
            await hevcDecoder.decode(frame.payload, frame.flags);
          } else if (frame.encoding === "h264") {
            await h264Decoder.decode(frame.payload, frame.flags);
          } else {
            const bitmap = await createImageBitmap(
              new Blob([frame.payload], { type: "image/jpeg" }),
            );
            await renderer.present(bitmap);
            statsWindow.recordDecodedFrame(performance.now());
          }
          setCodec(
            frame.encoding === "hevc"
              ? "HEVC / WebCodecs"
              : frame.encoding === "h264"
                ? "H.264 / WebCodecs"
                : "JPEG / Tight",
          );
        },
        onAudio: (message) => {
          if (message.kind === "config" && audioRef.current) setAudioAvailable(true);
          audioRef.current?.receive(message);
        },
        onClipboard: async (text) => {
          setManualClipboard(text);
          try {
            await navigator.clipboard.writeText(text);
            setClipboardNotice("Remote clipboard copied");
          } catch {
            setClipboardNotice("Remote clipboard ready below");
          }
        },
        onClipboardError: setClipboardNotice,
        fileSharing: true,
        onFileSharing: (capability) => {
          setFileSharing(capability);
          if (!capability) {
            setFilePanelOpen(false);
            setFileEntries([]);
            return;
          }
          void client
            ?.listFiles("")
            .then(setFileEntries)
            .catch((error) => setFileStatus(error.message));
        },
        onFileTransferProgress: setFileProgress,
      });
      sessionRef.current = client;
      try {
        await client.start();
      } finally {
        if (sessionRef.current === client) {
          readyRef.current = false;
          sessionRef.current = null;
          pressedKeysRef.current.clear();
        }
      }
    };

    let opened = false;
    const onOpen = () => {
      opened = true;
      void connect().catch((error) => setConnectionState(error.message));
    };
    const onPreOpenError = () => {
      if (!opened) setConnectionState("Desktop relay connection failed");
    };
    const onPreOpenClose = (event) => {
      if (!opened)
        setConnectionState(event.reason || `Desktop relay rejected connection (${event.code})`);
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onPreOpenError);
    socket.addEventListener("close", onPreOpenClose);
    return () => {
      disposed = true;
      clearInterval(statsTimer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onPreOpenError);
      socket.removeEventListener("close", onPreOpenClose);
      releasePressedKeys();
      releasePointerButtons();
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      readyRef.current = false;
      stream.close();
      h264Decoder?.close();
      hevcDecoder?.close();
      void audioRef.current?.close();
      audioRef.current = null;
      audioEnabledRef.current = false;
      renderer.clear();
      if (canvasRef.current) canvasRef.current.style.cursor = "default";
      setCursorImage(null);
      setRemotePointer(null);
      setLocalPointer(null);
      setHasPointerFocus(false);
    };
  }, [host?.id]);

  useEffect(() => {
    const onVisibility = () => {
      const muted = document.hidden || !audioEnabledRef.current;
      audioRef.current?.setMuted(muted);
      setAudioMuted(muted);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    let timer;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      const bounds = stage.getBoundingClientRect();
      setStageSize({ width: bounds.width, height: bounds.height });
      timer = setTimeout(() => {
        pendingResizeRef.current = { width: bounds.width, height: bounds.height };
        sessionRef.current?.resize(bounds.width, bounds.height);
      }, 500);
    });
    observer.observe(stage);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [host?.id]);

  const isCanvasStretched =
    Math.abs(stageSize.width - framebufferSize.width) > 0.5 ||
    Math.abs(stageSize.height - framebufferSize.height) > 0.5;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cursorImage) return;
    canvas.style.cursor = isCanvasStretched
      ? "none"
      : cursorCSS(
          cursorImage.dataURL,
          cursorImage.hotspotX,
          cursorImage.hotspotY,
          cursorImage.width,
          cursorImage.height,
        );
  }, [cursorImage, isCanvasStretched]);

  if (!host) {
    return (
      <main class="desktop-viewer desktop-viewer-missing">
        <strong>Desktop not found</strong>
        <button onClick={onExit}>Back to fleet</button>
      </main>
    );
  }

  const sendClipboard = async () => {
    if (!readyRef.current || !sessionRef.current) {
      setClipboardNotice("Connect before sending clipboard text");
      return;
    }
    try {
      await sessionRef.current.sendClipboardText(manualClipboard);
      setClipboardNotice("Clipboard sent to Mac");
    } catch (error) {
      setClipboardNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const pasteSystemClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setManualClipboard(text);
      setClipboardNotice("System clipboard loaded; press Send to share it");
    } catch {
      setClipboardNotice("Clipboard permission unavailable; paste into the field");
    }
  };

  const toggleAudio = async () => {
    const player = audioRef.current;
    if (!player) return;
    try {
      if (!audioEnabledRef.current) {
        await player.enableFromGesture();
        audioEnabledRef.current = true;
      } else {
        audioEnabledRef.current = false;
      }
      const muted = document.hidden || !audioEnabledRef.current;
      player.setMuted(muted);
      setAudioMuted(muted);
    } catch (error) {
      setConnectionState(error instanceof Error ? error.message : String(error));
    }
  };

  const selectQualityMode = (mode) => {
    setQualityMode(mode);
    saveViewerQuality(sessionStorage, host.id, mode);
    sessionRef.current?.setQualityMode(mode);
  };

  const loadFiles = async (path) => {
    const session = sessionRef.current;
    if (!session) return;
    setFileStatus("Loading…");
    try {
      setFileEntries(await session.listFiles(path));
      setFilePath(path);
      setFileStatus("");
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const downloadFile = async (entry) => {
    const session = sessionRef.current;
    if (!session) return;
    const path = filePath ? `${filePath}/${entry.name}` : entry.name;
    setFileStatus(`Downloading ${entry.name}…`);
    try {
      const blob = await session.downloadFile(path, entry.size);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = entry.name;
      link.click();
      URL.revokeObjectURL(url);
      setFileStatus(`Downloaded ${entry.name}`);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setFileProgress(null);
    }
  };

  const uploadFiles = async (files) => {
    const session = sessionRef.current;
    if (!session || !fileSharing?.allowWrites) return;
    let completed = true;
    for (const file of files) {
      const path = filePath ? `${filePath}/${file.name}` : file.name;
      setFileStatus(`Uploading ${file.name}…`);
      try {
        await session.uploadFile(path, file);
        setFileStatus(`Uploaded ${file.name}`);
      } catch (error) {
        setFileStatus(error instanceof Error ? error.message : String(error));
        completed = false;
        break;
      } finally {
        setFileProgress(null);
      }
    }
    if (completed) await loadFiles(filePath);
  };

  const createDirectory = async () => {
    const name = window.prompt("New folder name");
    if (!name) return;
    if (name.includes("/") || name === "." || name === "..") {
      setFileStatus("Choose a single folder name");
      return;
    }
    const path = filePath ? `${filePath}/${name}` : name;
    try {
      await sessionRef.current?.createDirectory(path);
      await loadFiles(filePath);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const showCursorOverlay =
    cursorImage &&
    remotePointer &&
    (isCanvasStretched || shouldShowCursorOverlay(remotePointer, localPointer, hasPointerFocus));
  const cursorOverlayStyle =
    showCursorOverlay && remotePointer
      ? {
          left: `${(remotePointer.x / framebufferSize.width) * 100}%`,
          top: `${(remotePointer.y / framebufferSize.height) * 100}%`,
          width: `${(cursorImage.width / framebufferSize.width) * 100}%`,
          height: `${(cursorImage.height / framebufferSize.height) * 100}%`,
          transform: `translate(-${(cursorImage.hotspotX / cursorImage.width) * 100}%, -${(cursorImage.hotspotY / cursorImage.height) * 100}%)`,
        }
      : undefined;

  return (
    <main class="desktop-viewer">
      <header class="desktop-viewer-bar">
        <div class="desktop-viewer-title">
          <span class="desktop-live-dot" aria-hidden="true" />
          <div>
            <strong>{serverName}</strong>
            <span>{connectionState}</span>
          </div>
        </div>
        <div class="desktop-viewer-tools">
          {statsVisible ? (
            <div class="desktop-viewer-stats" aria-label="Stream statistics">
              <span>{codec}</span>
              <span>{stats.fps.toFixed(0)} fps</span>
              <span>{stats.mbitPerSecond.toFixed(2)} Mbit/s</span>
              <span>{stats.droppedAudio} audio drops</span>
              <span>{stats.jitterMs.toFixed(0)} ms jitter</span>
            </div>
          ) : null}
          <div class="desktop-quality-picker" role="group" aria-label="Viewer quality">
            {["auto", "sharp", "smooth"].map((mode) => (
              <button
                key={mode}
                class={qualityMode === mode ? "active" : ""}
                aria-pressed={qualityMode === mode}
                onClick={() => selectQualityMode(mode)}
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
          <button
            class="desktop-tool-button"
            onClick={() => setStatsVisible((visible) => !visible)}
          >
            {statsVisible ? "Hide stats" : "Stats"}
          </button>
          {audioAvailable ? (
            <button class="desktop-tool-button" onClick={toggleAudio}>
              {audioMuted ? "Unmute audio" : "Mute audio"}
            </button>
          ) : null}
          {fileSharing ? (
            <button
              class="desktop-tool-button"
              aria-pressed={filePanelOpen}
              onClick={() => setFilePanelOpen((open) => !open)}
            >
              {filePanelOpen ? "Hide files" : `Files · ${fileSharing.displayName}`}
            </button>
          ) : null}
        </div>
        <button
          class="danger"
          onClick={() => {
            sessionRef.current?.disconnect();
            onExit();
          }}
        >
          Disconnect
        </button>
      </header>
      <section ref={stageRef} class="desktop-viewer-stage">
        <div class="desktop-viewer-canvas">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label={`Remote desktop ${serverName}`}
            onContextMenu={(event) => event.preventDefault()}
            onPointerEnter={(event) => {
              setHasPointerFocus(true);
              const session = sessionRef.current;
              if (!readyRef.current || !session?.width || !session.height) return;
              noteLocalPointer(
                pointerCoordinates(event, event.currentTarget, session.width, session.height),
                false,
              );
            }}
            onPointerLeave={() => {
              setHasPointerFocus(false);
              setLocalPointer(null);
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              const session = sessionRef.current;
              if (!readyRef.current || !session?.width || !session.height) return;
              const point = pointerCoordinates(
                event,
                event.currentTarget,
                session.width,
                session.height,
              );
              const mask = pointerButtonMask(event.buttons);
              pointerRef.current = { ...point, buttonsDown: mask !== 0 };
              noteLocalPointer(point);
              session.sendPointer(mask, point.x, point.y);
            }}
            onPointerMove={(event) => {
              event.preventDefault();
              const session = sessionRef.current;
              if (!readyRef.current || !session?.width || !session.height) return;
              const point = pointerCoordinates(
                event,
                event.currentTarget,
                session.width,
                session.height,
              );
              const mask = pointerButtonMask(event.buttons);
              pointerRef.current = { ...point, buttonsDown: mask !== 0 };
              noteLocalPointer(point);
              session.sendPointer(mask, point.x, point.y);
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              const session = sessionRef.current;
              if (!readyRef.current || !session?.width || !session.height) return;
              const point = pointerCoordinates(
                event,
                event.currentTarget,
                session.width,
                session.height,
              );
              const mask = pointerButtonMask(event.buttons);
              pointerRef.current = { ...point, buttonsDown: mask !== 0 };
              noteLocalPointer(point);
              session.sendPointer(mask, point.x, point.y);
            }}
            onPointerCancel={releasePointerButtons}
            onLostPointerCapture={releasePointerButtons}
            onWheel={(event) => {
              event.preventDefault();
              const session = sessionRef.current;
              if (!readyRef.current || !session?.width || !session.height) return;
              const point = pointerCoordinates(
                event,
                event.currentTarget,
                session.width,
                session.height,
              );
              const baseMask = pointerButtonMask(event.buttons);
              pointerRef.current = { ...point, buttonsDown: baseMask !== 0 };
              noteLocalPointer(point);
              session.sendPointer(
                baseMask | scrollButtonMask(event.deltaX, event.deltaY),
                point.x,
                point.y,
              );
              session.sendPointer(baseMask, point.x, point.y);
            }}
            onKeyDown={(event) => {
              const code = event.code || event.key;
              const pressed = pressedKeysRef.current.get(code);
              const keysym = pressed ?? keysymForKey(event.key);
              if (keysym === null) return;
              event.preventDefault();
              if (!readyRef.current || !sessionRef.current) return;
              if (pressed === undefined) pressedKeysRef.current.set(code, keysym);
              sessionRef.current?.sendKey(true, keysym);
            }}
            onKeyUp={(event) => {
              const code = event.code || event.key;
              const pressed = pressedKeysRef.current.get(code);
              if (pressed === undefined) {
                if (keysymForKey(event.key) !== null) event.preventDefault();
                return;
              }
              event.preventDefault();
              pressedKeysRef.current.delete(code);
              if (readyRef.current) sessionRef.current?.sendKey(false, pressed);
            }}
            onBlur={() => {
              releasePressedKeys();
              releasePointerButtons();
            }}
          />
          {showCursorOverlay && (
            <img
              class="desktop-cursor-overlay"
              src={cursorImage.dataURL}
              style={cursorOverlayStyle}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
          )}
        </div>
        {fileSharing && filePanelOpen ? (
          <aside
            class="desktop-file-panel"
            onDragOver={(event) => {
              if (fileSharing.allowWrites) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!fileSharing.allowWrites) return;
              event.preventDefault();
              void uploadFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <header>
              <div>
                <strong>{fileSharing.displayName}</strong>
                <span>/{filePath}</span>
              </div>
              <button
                disabled={!filePath}
                onClick={() => void loadFiles(filePath.split("/").slice(0, -1).join("/"))}
              >
                Up
              </button>
            </header>
            <div class="desktop-file-list" role="list" aria-label="Shared folder files">
              {fileEntries.length ? (
                fileEntries.map((entry) => (
                  <button
                    key={entry.name}
                    class="desktop-file-entry"
                    onClick={() =>
                      entry.isDirectory
                        ? void loadFiles(filePath ? `${filePath}/${entry.name}` : entry.name)
                        : void downloadFile(entry)
                    }
                  >
                    <span aria-hidden="true">{entry.isDirectory ? "▸" : "↓"}</span>
                    <strong>{entry.name}</strong>
                    <small>{entry.isDirectory ? "Folder" : formatFileSize(entry.size)}</small>
                  </button>
                ))
              ) : (
                <p class="desktop-file-empty">This folder is empty.</p>
              )}
            </div>
            {fileSharing.allowWrites ? (
              <div class="desktop-file-upload">
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    void uploadFiles(Array.from(event.currentTarget.files || []));
                    event.currentTarget.value = "";
                  }}
                />
                <button onClick={() => uploadInputRef.current?.click()}>Upload files</button>
                <button onClick={() => void createDirectory()}>New folder</button>
                <span>or drop files here</span>
              </div>
            ) : (
              <p class="desktop-file-readonly">Uploads disabled by host</p>
            )}
            {fileProgress ? (
              <progress value={fileProgress.completed} max={Math.max(1, fileProgress.total)} />
            ) : null}
            {fileStatus ? <p class="desktop-file-status">{fileStatus}</p> : null}
          </aside>
        ) : null}
        <div class="desktop-viewer-hint">Click display to capture keyboard · Esc sends to Mac</div>
      </section>
      <aside class="desktop-clipboard">
        <label for="desktop-clipboard-text">Clipboard</label>
        <textarea
          id="desktop-clipboard-text"
          value={manualClipboard}
          placeholder="Paste text here when browser clipboard permission is unavailable"
          onInput={(event) => setManualClipboard(event.currentTarget.value)}
        />
        <button onClick={sendClipboard}>Send to Mac</button>
        <button onClick={pasteSystemClipboard}>Load system clipboard</button>
        <span>{clipboardNotice}</span>
      </aside>
    </main>
  );
}

/** Resolve masked, tab-scoped credentials before a direct transport is opened. */
export async function browserDirectRFBAuthentication(hostID) {
  let storage = null;
  try {
    storage = window.sessionStorage;
  } catch {}
  return directRFBAuthentication(hostID, storage, requestBrowserRFBPassword);
}

export function requestBrowserRFBPassword() {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    const form = document.createElement("form");
    const title = document.createElement("h2");
    const description = document.createElement("p");
    const label = document.createElement("label");
    const input = document.createElement("input");
    const actions = document.createElement("div");
    const cancel = document.createElement("button");
    const connect = document.createElement("button");
    const titleID = `rfb-password-title-${crypto.randomUUID()}`;

    dialog.className = "action-dialog";
    dialog.setAttribute("aria-labelledby", titleID);
    form.className = "action-dialog-surface";
    title.id = titleID;
    title.textContent = "Connect to shared Mac";
    description.textContent = "Enter the 12-character Crabfleet sharing password.";
    label.textContent = "Sharing password";
    input.type = "password";
    input.autocomplete = "one-time-code";
    input.setAttribute("autocapitalize", "none");
    input.setAttribute("autocorrect", "off");
    input.spellcheck = false;
    input.required = true;
    input.maxLength = 12;
    input.pattern = "[A-Za-z0-9]{12}";
    actions.className = "action-dialog-actions";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    connect.type = "submit";
    connect.className = "primary";
    connect.textContent = "Connect";

    label.append(input);
    actions.append(cancel, connect);
    form.append(title, description, label, actions);
    dialog.append(form);
    document.body.append(dialog);

    const finish = (password) => {
      input.value = "";
      dialog.remove();
      resolve(password);
    };
    cancel.addEventListener("click", () => finish(null), { once: true });
    dialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        finish(null);
      },
      { once: true },
    );
    form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        finish(input.value);
      },
      { once: true },
    );
    dialog.showModal();
    input.focus();
  });
}
