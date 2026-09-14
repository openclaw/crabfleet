---
title: Quickstart
layout: default
permalink: /quickstart/
description: "Connect to a VNC desktop and share your own computer with Crabfleet."
---

# Quickstart

Crabfleet has two ways to connect: direct VNC in the Mac app, or an authenticated relay in the browser. Sign-in adds discovery; direct connections still need a reachable host and its VNC password. See [connection modes](/connections/) for the differences.

## Build and install the Mac app

If you already have Crabfleet installed, continue to the next section. Source builds require macOS 14 or later, the full Xcode toolchain, Node.js 24 or later, and the pnpm version declared in `package.json`. Run from the repository root:

```sh
pnpm install --frozen-lockfile
CODE_SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)" pnpm macos:bundle
open -R macos/CrabfleetMac/.build/Crabfleet.app
```

The example uses the maintainer's signing identity. Substitute your own real Developer ID for local builds. Quit any running copy, drag the revealed app into **Applications** in Finder, and choose **Replace** if prompted. Open `/Applications/Crabfleet.app` after installation. Replace the entire bundle on updates so removed files do not linger; keep the same signing identity and installation path so screen-capture, input, and Keychain access retain a stable app identity.

## Connect from a Mac

Open Crabfleet and choose **Use Local VNC Only**. Add a saved VNC connection or use Quick Connect with your server address and password. Focus a desktop to control it; other open sessions can stay warm for switching.

Addresses may be a host name, `host:port`, a `vnc://` URL, or bracketed IPv6. Crabfleet can remember connection details and optionally store the password in macOS Keychain.

Direct VNC authentication does not encrypt ordinary TCP traffic. Use a trusted private network or SSH tunnel for third-party VNC servers. Crabfleet's Mac sharing uses Tailscale and prefers pinned QUIC with TCP fallback.

## Share a Mac

Run Tailscale on both Macs under the same user identity, then choose **Share This Mac**. Grant Screen Recording for capture and Accessibility if you want remote keyboard and pointer control. Use the signed app at `/Applications/Crabfleet.app` so macOS permissions retain a stable identity.

Choose displays and optional system audio or a shared folder. On the other Mac, use Quick Connect with the displayed address and fresh share password. Keep Crabfleet running while sharing.

## Discover your computers

Connect the Mac app to `https://crabfleet.openclaw.ai` or your own desktop service, then approve its device link in the browser. The app stores a discovery credential in Keychain. Your account must be allowed by that service's owner.

Native sign-in grants discovery only. Mac host publication currently needs a separate browser session supplied at launch through `CRABFLEET_API_URL` and `CRABFLEET_SESSION_COOKIE`; see the [Mac guide](/macos-native-client/) for that setup. Direct Mac sharing works independently of publication.

The [browser companion](https://crabfleet.openclaw.ai/app/) lists your published desktops. Select **Connect** on a relay-capable computer to open it in the browser.

## Share Linux

```sh
go build -o ./dist/crabfleet-connect ./cmd/crabfleet-connect
./dist/crabfleet-connect login --server https://crabfleet.openclaw.ai
./dist/crabfleet-connect share --fleet
```

Run this inside the Linux graphical session and approve the connector's desktop publication permission. Open **Your desktops → Connect** in the browser companion. For native access, also bind and advertise the host's Tailscale address as described in the [Linux connector guide](/linux-connector/).

## Share Windows

The Windows connector captures the primary display for direct VNC connections. Build it with Go and run it inside the signed-in Windows desktop. See the [Windows guide](/windows-connector/) for the PowerShell commands, private-network setup, and current feature limits.

## If a connection does not appear

Confirm the host is still sharing and that both browsers/apps use the same account and service. A Linux share without an advertised address is available through the browser relay only. A Mac sharing directly needs publication configured before it appears in discovery. For a saved connection, check the address, private-network reachability, and VNC password.
