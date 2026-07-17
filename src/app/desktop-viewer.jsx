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
import { ViewerStatsWindow } from "./rfb/stats.ts";

export function desktopViewerHostID(pathname = location.pathname) {
  const match = pathname.match(/^\/app\/desktops\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
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
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioMuted, setAudioMuted] = useState(true);
  const [manualClipboard, setManualClipboard] = useState("");
  const [clipboardNotice, setClipboardNotice] = useState("");

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
    const releaseInput = () => {
      releasePressedKeys();
      releasePointerButtons();
    };
    window.addEventListener("blur", releaseInput);
    return () => window.removeEventListener("blur", releaseInput);
  }, []);

  useEffect(() => {
    if (!host || !canvasRef.current) return undefined;
    audioEnabledRef.current = false;
    setAudioMuted(true);
    setAudioAvailable(false);
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
        hevc,
        h264,
        chroma444: hevc && rext,
        audio,
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
        },
        onResize: () => {},
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
      timer = setTimeout(() => {
        const bounds = stage.getBoundingClientRect();
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
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`Remote desktop ${serverName}`}
          onContextMenu={(event) => event.preventDefault()}
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
