---
title: Windows Connector
layout: default
permalink: /windows-connector/
description: "Build the Windows connector and share the primary display over private direct VNC."
---

# Windows connector

`crabfleet-connect.exe` shares the primary Windows display with the Crabfleet Mac app or another VNC viewer. Run it inside the signed-in graphical desktop. It provides password authentication, Tight/JPEG or RAW frames, keyboard and pointer input, and view-only mode.

## Build

Use the Go version specified in `go.mod` or a newer compatible version. From the repository root in PowerShell:

```powershell
go build -trimpath -o .\dist\crabfleet-connect.exe .\cmd\crabfleet-connect
.\dist\crabfleet-connect.exe --version
```

The current release configuration packages Linux connectors. Build the Windows executable from source; the same command selects the architecture of your Go installation.

## Share the primary display

For a local connection or an SSH tunnel:

```powershell
.\dist\crabfleet-connect.exe share
```

The listener defaults to `127.0.0.1:5900`. The process prints a freshly generated VNC password when it starts. Keep that terminal open while sharing and use Ctrl+C to stop.

To connect from another computer, bind explicitly to the Windows host's protected private interface. For example, if its Tailscale IPv4 address is `100.64.1.2`:

```powershell
.\dist\crabfleet-connect.exe share --bind 100.64.1.2 --port 5900
```

Use your host's actual address, keep Windows Firewall access restricted to the intended private network, and enter that address and the printed password in the Mac app's Quick Connect. VNC password authentication does not encrypt the TCP stream; use Tailscale or another protected connection.

Add `--view-only` to disable remote keyboard and pointer input. Restarting the connector generates a new share password.

## Current limits

Windows hosting captures the primary display. It does not publish desktops to the browser companion or provide login, logout, status, password-storage, doctor, or service commands. Those commands currently require Linux.

Clipboard synchronization, system audio, shared-folder transfer, and the configurable H.264/HEVC encoder path are also unavailable in the Windows connector. Leave `--video` at its default; `--fleet`, `--audio`, `--shared-folder`, and `--quiet` are not supported on Windows.

Use a saved direct connection in the Mac app. See [connection modes](/connections/) for the distinction between direct VNC and browser relay, or the [Linux guide](/linux-connector/) for the connector's fuller publication and media support.
