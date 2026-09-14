---
title: Quickstart
layout: default
permalink: /quickstart/
description: "Connect to a VNC desktop and share your own computer with Crabfleet."
---

# Quickstart

## Connect from a Mac

Open Crabfleet and choose **Use Local VNC Only**. Add a saved VNC connection or use Quick Connect with your server address and password. Focus a desktop to control it; other open sessions can stay warm for switching.

Direct VNC authentication does not encrypt ordinary TCP traffic. Use a trusted private network or SSH tunnel for third-party VNC servers. Crabfleet's Mac sharing uses Tailscale and prefers pinned QUIC with TCP fallback.

## Share a Mac

Choose **Share This Mac**. Grant Screen Recording for capture and Accessibility if you want remote keyboard and pointer control. Use the signed app at `/Applications/Crabfleet.app` so macOS permissions retain a stable identity.

Choose displays and optional system audio or a shared folder. The host shows the direct address and a fresh password. Keep Crabfleet running while sharing.

## Discover your computers

Sign in to your desktop service from the Mac app and approve its device link in the browser. The app stores a scoped credential in Keychain. Host publication registers your computer under your account; see the [Mac guide](/macos-native-client/) for its current publication setup.

The [browser companion](https://crabfleet.openclaw.ai/app/) lists your published desktops. Select **Connect** on a relay-capable computer to open it in the browser.

## Share Linux

```sh
go build -o ./dist/crabfleet-connect ./cmd/crabfleet-connect
./dist/crabfleet-connect login --server https://crabfleet.openclaw.ai
./dist/crabfleet-connect share --fleet
```

Approve the connector's separate desktop publication permission. See the [Linux connector guide](/linux-connector/) for desktop-specific dependencies, direct VNC, service installation, audio, and file sharing.
