# Crabfleet Connect

`crabfleet-connect` shares a desktop through the common Go RFB 3.8 host. The
[Linux connector guide](../../docs/linux-connector.md) covers installation,
Fleet sign-in, browser relay, native VNC connections, and service management.

Linux supports X11 capture/input, Hyprland and wlroots through a supervised
wayvnc 0.10+ process, and GNOME/KDE through the desktop portal and PipeWire.
Negotiated features include hardware or software H.264/HEVC with Tight/JPEG and RAW fallback,
UTF-8 clipboard, opt-in system output audio, and explicitly selected shared folders.
Fleet publication uses its own consent scope and durable ownership recovery.
A systemd user service and desktop autostart provide graphical-session startup.
Use `--all-monitors` for simultaneous outputs and `--allow-resize` to permit
supported monitor-mode changes. `--encoder auto` selects detected NVENC or VAAPI
before software; explicit backend selection is also available. An optional
[SDDM Wayland greeter wrapper](../../docs/linux-greeter.md) shares the login screen
under a separate greeter identity while preserving normal OS authentication.

```sh
go build -o ./dist/crabfleet-connect ./cmd/crabfleet-connect
./dist/crabfleet-connect login --server https://fleet.example
./dist/crabfleet-connect share --fleet
```

The Windows backend retains GDI primary-display capture, SendInput keyboard and
pointer input, VNC password authentication, Tight/JPEG, and client-side cursors.
The Linux helpers, Fleet commands, saved-password quiet mode, and service management are Linux-only. Windows
DXGI, multi-monitor and per-monitor DPI remain separate work.

Both platforms fail when real capture cannot initialize. `--synthetic` explicitly
selects a test pattern, and `--view-only` blocks remote input. Direct listeners
bind loopback by default; use an SSH tunnel or an explicit protected interface.
VNC-DES authenticates but does not encrypt traffic. ARD is not offered. Only an
ownership-authenticated Fleet relay creates an inner RFB None session.

All inbound lengths are bounded, media writes have deadlines, viewer counts are
bounded, and shutdown releases input and closes helpers and active sessions.
Tests include malformed protocol payloads, real headless Wayland capture/input,
FFmpeg encode/decode, and isolated D-Bus portal lifecycle coverage.
