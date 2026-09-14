---
title: Linux Connector
layout: default
permalink: /linux-connector/
description: "Linux desktop sharing, Fleet browser relay, clipboard, audio, files, and unattended service startup."
---

# Linux connector

`crabfleet-connect` shares your Linux desktop in Crabfleet's browser viewer,
native macOS viewer, or another RFB 3.8 VNC client. Run it as the desktop user
inside the graphical session. It supports X11, Hyprland/wlroots through wayvnc,
and GNOME/KDE through the desktop portal and PipeWire.

## Install

Use the Linux amd64 or arm64 `crabfleet-connect` archive from a release, or build
with the Go version specified in `go.mod`:

```sh
go build -trimpath -o ./dist/crabfleet-connect ./cmd/crabfleet-connect
install -Dm755 ./dist/crabfleet-connect ~/.local/bin/crabfleet-connect
crabfleet-connect doctor
```

The Go executable is self-contained. Install the helpers for your session:

| Session or feature                 | Required helpers                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| X11 capture and input              | X server with MIT-SHM, XFixes, and XTest                                                                                                     |
| X11 text clipboard                 | `xclip`                                                                                                                                      |
| Hyprland, Sway, compatible wlroots | `wayvnc` 0.10 or newer; `wl-copy` and `wl-paste` for clipboard                                                                               |
| GNOME or KDE Wayland               | `xdg-desktop-portal`, the matching GNOME/KDE portal backend, PipeWire, `gst-launch-1.0` with `pipewiresrc`, `videoconvert`, and `videoscale` |
| H.264 / HEVC video                 | FFmpeg with VAAPI, NVENC, or `libx264` / `libx265`; hardware encoding also needs a compatible GPU driver and device access                   |
| System output audio                | FFmpeg with PulseAudio input and AAC encoding; `pactl`; PulseAudio or PipeWire's Pulse server                                                |
| Background startup                 | A systemd user manager and graphical desktop autostart                                                                                       |

For example, Arch's wlroots setup uses `wayvnc wl-clipboard ffmpeg libpulse`;
X11 additionally uses `xclip`. Install the distribution's portal packages for
GNOME or Plasma. Package names and portal feature support vary by distribution.
`doctor` reports missing helpers; clipboard can be disabled explicitly with
`--clipboard=false`, and `--video jpeg` needs no FFmpeg.

## Share in Fleet

```sh
crabfleet-connect login --server https://fleet.example
crabfleet-connect share --fleet --name "Linux workstation"
```

Approve the connector in the opened browser page. The consent grants management
of your own desktop registrations, not terminal or general Fleet API access.
The connector publishes an authenticated WebSocket relay; open its card under
**Shared desktops** in Fleet. Browser sharing needs only an outbound HTTPS
connection. The direct VNC listener remains on loopback by default.

Sign-in state lives in `$XDG_CONFIG_HOME/crabfleet-connect/state.json` (normally
`~/.config/crabfleet-connect/state.json`). The directory is mode 0700 and the
file is mode 0600. The connector saves a stable desktop identity and the exact
publication recovery identity before registering, reconnects with bounded
backoff, and removes its own registration on shutdown. If cleanup cannot reach
Fleet, the next start retries it. A replacement publication stops this process
without deleting the replacement.

Authorization lasts 24 hours and is renewed every five minutes while sharing;
each renewal rechecks the account's access. After a longer offline period,
stop sharing, run `logout`, and sign in again. `status` reports the saved account
and expiry without showing credentials. Stop an active service before running
`login` or `logout`, because one process holds the configuration lock.

The server must include migrations `0044_linux_connector_authorization.sql`
and `0045_desktop_host_relay_only.sql` and the connector API before sign-in.
Existing native viewer authorization retains its separate `fleet:read` scope.
The connector's `desktop:publish` token cannot use those viewer endpoints.

## Select a desktop

```sh
crabfleet-connect share --fleet                         # automatic selection
crabfleet-connect share --backend wayland --output DP-1
crabfleet-connect share --fleet --all-monitors
crabfleet-connect share --fleet --allow-resize
crabfleet-connect share --backend portal --fleet        # GNOME/KDE dialog
crabfleet-connect share --display :0                    # an actual X11 session
crabfleet-connect share --view-only
```

Automatic selection prefers Wayland over XWayland when `WAYLAND_DISPLAY` or
`XDG_SESSION_TYPE=wayland` is set. GNOME and KDE select the portal; other Wayland
sessions select wayvnc. An explicit `--display` selects X11. Unsupported capture
or missing permissions fail startup; synthetic pixels require `--synthetic`.

Wayvnc shares one named output or its first output. `--all-monitors` selects the
active outputs at startup and arranges them side by side in stable output-name
order; it does not reproduce their physical arrangement. Restart sharing after
adding or removing an output. `--output` and `--all-monitors` are mutually
exclusive. Use `hyprctl monitors` or `swaymsg -t get_outputs` to find names.
The connector supervises a private wayvnc process per selected output, each with
a sealed anonymous password configuration and a Unix socket
inside a private temporary directory. Your existing wayvnc configuration is
not read or changed. The private RFB client authenticates, captures RAW frames,
and forwards input into the common Crabfleet RFB server. Crossing between
wayvnc outputs releases and reapplies held buttons on their separate input
devices, so a cross-monitor drag may be interrupted. Shutdown terminates and
reaps all helpers.

The GNOME/KDE portal asks you to select a monitor and approve input and clipboard
permissions. By default select one monitor; `--all-monitors` requests permission
for multiple monitors, with up to 16 selected streams arranged using the portal's
logical positions. The desktop decides which monitors you may select. Portal restore tokens are saved and
rotated when the desktop supports persistence; the desktop may still require
approval after sign-out, revocation, or an upgrade. This is sharing of a logged-in
graphical session. For supported login screens, use the separate
[SDDM greeter integration](../linux-greeter/). Revoking the portal session stops
sharing. A capture-process failure exits with an error so a service can restart.
Older portals without clipboard support need `--clipboard=false`.

X11 captures the default screen, including its RandR monitors, and uses the
session's `DISPLAY` and Xauthority. Multi-group XKB keyboards use the primary
group's base and Shift levels. Capture adapts to root geometry and monitor-layout
changes. Portal streams scale to their selected logical sizes.

Desktop geometry changes are announced through negotiated RFB desktop-size
extensions before new pixels. Clients without those extensions disconnect before
receiving incompatible dimensions. Viewer-requested mode changes are off by
default: `--allow-resize` enables them on supported X11/RandR and wayvnc outputs;
`--view-only` still prohibits them. X11 supports existing single-monitor RandR
modes. Compositors may reject unsupported modes. The portal cannot change the
physical display mode. Fleet's browser stops automatically requesting resize
when a host prohibits it.

## Clipboard, audio, video, and files

Text clipboard synchronization is enabled by default. Crabfleet peers negotiate
UTF-8 extended clipboard; legacy VNC peers use Latin-1. Existing clipboard text
is not exported when a viewer connects; subsequent changes are shared. Clipboard
payloads and decompression are bounded to 1 MiB. `--view-only` disables incoming
keyboard, pointer, clipboard writes, and shared-folder writes.

```sh
crabfleet-connect share --fleet --audio
crabfleet-connect share --fleet --video h264
crabfleet-connect share --fleet --video hevc
crabfleet-connect share --fleet --encoder vaapi
crabfleet-connect share --fleet --encoder software
crabfleet-connect share --fleet --shared-folder "$HOME/Public"
crabfleet-connect share --fleet --shared-folder "$HOME/Public" --shared-folder-write
```

Audio is opt-in and captures the default output sink's monitor, never the
default microphone. It uses negotiated AAC-LC, 48 kHz stereo, with bounded queues
and dropped late packets. Select the output device before starting the connector.

Video defaults to negotiated HEVC, then H.264, then Tight/JPEG, with RAW available
for basic VNC clients. FFmpeg uses persistent encoders and independent
frames so a new viewer can decode immediately. HEVC uses Main profile for browser
compatibility while keeping every frame independently decodable. A missing encoder or an unsupported
frame size falls back to JPEG/RAW when the viewer offers them. `--video h264` or
`hevc` restricts the preferred codec; it still permits the negotiated fallback.
`--encoder auto` tries detected NVIDIA NVENC, then VAAPI, then software. VAAPI
uses `/dev/dri/renderD128` unless overridden with `--render-device`; the desktop
user needs access to that render node. Explicit `--encoder vaapi`, `nvenc`, or
`software` restricts the encoder backend while preserving negotiated codec and
JPEG/RAW fallback. Failures are cached for up to four recent frame sizes per
codec/backend, so another size can retry hardware after a resize-related failure.
Missing or non-device hardware paths are disabled until sharing restarts.
Selection and bounded failure diagnostics are reported once. Hardware
minimum dimensions and supported profiles vary by GPU and driver. Odd video
dimensions use the negotiated fallback without disabling an otherwise healthy
encoder.

File sharing is off until you select a folder. Crabfleet peers negotiate the
same FSH1 list, download, upload, and create-directory protocol as the Mac host.
Writes require `--shared-folder-write` and a controlling session. Paths remain
inside an opened filesystem root, with symlink escapes and special files rejected.
Uploads become visible only after a completed atomic finish, and never overwrite
an existing file. Each file is limited to 512 MiB, each chunk to 256 KiB, and each
directory listing to 1,024 entries. Incomplete uploads are removed on disconnect.

## Native or generic VNC viewers

For Fleet's native macOS viewer over Tailscale, advertise the exact private
interface you bind:

```sh
crabfleet-connect share --fleet --bind 100.64.1.2 --advertise 100.64.1.2
crabfleet-connect password
```

Enter the share password in the native viewer. Without `--advertise`, the Fleet
card is a browser relay and has no native direct endpoint. Update the Mac viewer
to recognize these cards. Generic VNC clients negotiate VNC password authentication;
ARD authentication is not offered by this connector.

Direct VNC authentication does not encrypt screen traffic. Use the Tailscale
interface or an SSH tunnel to the default loopback listener:

```sh
ssh -N -L 5901:127.0.0.1:5900 user@linux-host
```

Connect the viewer to `127.0.0.1:5901`. `--port` changes the local port. A manual
share prints its password. Fleet, portal, and service shares retain their password
in private state; `password` retrieves it. Other manual shares generate a fresh
password on each run. `--quiet` keeps passwords out of service logs.

## Start with your desktop

Install the binary in a permanent location, sign in, then run:

```sh
crabfleet-connect service install -- --fleet --audio
crabfleet-connect service start
crabfleet-connect service status
journalctl --user -u crabfleet-connect.service
crabfleet-connect service stop
crabfleet-connect service uninstall
crabfleet-connect logout
```

Installation writes a systemd user service and a desktop autostart entry, then
enables the service. It starts at graphical login and stops with the graphical
session. `service start` imports the desktop environment before starting it.
No root service or lingering login is configured. The service suppresses passwords,
restarts unexpected failures, bounds restart attempts, and stops its whole process
group. Installation rejects invalid sharing options and refuses to overwrite
unmanaged files. Uninstall preserves account settings for manual use.

## Validation

Protocol and lifecycle tests cover authentication, negotiation, bounded malformed
payloads, clipboard, file containment and atomic uploads, relay framing,
publication recovery, service arguments, and D-Bus portal requests. The isolated
D-Bus test uses a fixture portal; it does not establish GNOME/KDE compatibility
by itself.

```sh
pnpm check
pnpm test
pnpm test:native
CRABFLEET_TEST_MEDIA=1 go test -race ./internal/connect -run TestFFmpegLive -v
CRABFLEET_TEST_MEDIA=1 CRABFLEET_TEST_VIDEO_ENCODER=vaapi go test -race ./internal/connect -run FFmpeg -v
sh scripts/test-linux-connector.sh
sh scripts/test-linux-audio.sh
```

The first three commands are the local gates. On Linux, native validation runs
all Go tests with the race detector and Go vet; macOS app tests require a Mac
and are reported as not run. No Crabbox login is needed for local validation.

The Wayland script requires Sway, wayvnc 0.10+, `wev`, and a session bus. It creates
and cleans up a disposable headless compositor, checks real pixels, rejects a
wrong password, and observes remote mouse and keyboard events in an independent
Wayland client. It does not capture or inject into the operator's active desktop.

The audio script starts a private PulseAudio server with only a synthetic null
sink. It generates a tone, captures the output monitor, decodes AAC, verifies
non-silent samples, and checks cancellation without accessing physical audio.
