# Crabfleet Connect foundation

`crabfleet-connect` is the cross-platform host foundation for sharing a Linux or Windows machine to Crabfleet's macOS viewer or browser client.

Real in this increment:

- RFB 3.8 server handshake and direct-listener VNC-DES authentication with an eight-character per-run share password; Security None is never offered.
- Tight/JPEG full-frame updates, client-side cursor pseudo-encodings, pointer/key input, strict protocol bounds, bounded sessions, and idempotent teardown.
- A pure-Go synthetic capture/input backend used by tests and as an explicit fallback.
- A Linux X11 backend implemented with MIT-SHM `XShmGetImage` capture, XFixes cursor images, and XTest input with key-level modifier mapping. It compiles for Linux; it has not been validated on physical Linux hardware in this track. Multi-group XKB layouts fail closed to the synthetic fallback rather than risking incorrect input.
- A pure-Go Windows backend implemented with synchronized GDI `BitBlt` primary-display capture and `SendInput` for absolute pointer, wheel, virtual-key shortcut, and layout-independent Unicode text input. Its named-key table and canonical legacy X11 keysym conversion are tested on every platform, and the host cross-builds as amd64 and arm64 PE executables. It has not been run on physical Windows hardware in this track.

Deferred:

- ARD host authentication. Type 30 remains in the Track H-compatible security offer but fails closed; VNC-DES type 2 is the working MVP.
- H.264/HEVC hardware encoding, Wayland/PipeWire capture, Windows DXGI Desktop Duplication, Windows multi-monitor and per-monitor-DPI support, multi-group XKB input, audio, clipboard synchronization, packaging/service installation, and real-hardware validation.

Run:

```sh
go run ./cmd/crabfleet-connect --display :0 --port 5900
```

On Windows, omit `--display`; the native backend captures the primary display:

```powershell
go run ./cmd/crabfleet-connect --port 5900
```

The process prints its per-run share password and listener address. If native capture cannot initialize, it says why and uses the synthetic test pattern. Use `--synthetic` to force that backend. The listener defaults to `127.0.0.1` because VNC-DES authenticates but does not encrypt the RFB session. Use `--bind` to select a private interface only when the network path is already protected, such as through an authenticated tunnel; `--bind 0.0.0.0` is an explicit insecure exposure.
