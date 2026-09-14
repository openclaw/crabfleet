---
title: Connection Modes
layout: default
permalink: /connections/
description: "Choose direct VNC, private desktop discovery, or the authenticated browser relay."
---

# Connection modes

Crabfleet connects to desktops in the native Mac app or the browser. Discovery supplies a list of computers; the connection path determines how you reach and authenticate to one.

| Mode                       | Viewer            | What you need                                                                                             |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| Saved or Quick Connect VNC | Mac app           | A reachable VNC address and the server's credentials                                                      |
| Discovered direct desktop  | Mac app           | Desktop-service sign-in, a published direct address, private-network reachability, and the share password |
| Published browser relay    | Browser companion | Browser sign-in to the host owner's account and a running relay-enabled publisher                         |

## Direct VNC

Choose **Use Local VNC Only** to connect without a desktop-service account. Save a connection or use Quick Connect. Crabfleet works with ordinary VNC servers, including the basic Windows connector.

For **Share This Mac**, both endpoints need Tailscale identities belonging to the same user. The Mac host checks the connecting peer and still requires its share password. Discovered Mac hosts advertise pinned QUIC with TCP fallback; a manually entered VNC address uses the direct connection information you supply.

Linux and Windows connectors bind to loopback by default. Bind to a private interface for remote access or use an SSH tunnel. Ordinary VNC password authentication does not encrypt TCP screen traffic. Desktop-service sign-in does not create a private network or tunnel for native connections.

## Private discovery

The Mac app requests a `fleet:read` credential through browser approval. It can discover your published desktops but cannot publish a host using that credential. Owners and maintainers still see only their own desktops.

Linux uses `crabfleet-connect login` followed by `share --fleet` to obtain separate publication permission. To make that share directly reachable from the Mac viewer, add matching `--bind` and `--advertise` Tailscale addresses. A share without `--advertise` is relay-only.

Mac publication currently uses a browser session provided through launch configuration. See the [Mac guide](/macos-native-client/) for `CRABFLEET_API_URL` and `CRABFLEET_SESSION_COOKIE`. Windows publication and account commands are not implemented.

## Browser relay

Open the [browser companion](https://crabfleet.openclaw.ai/app/) and sign in to the same account that published the computer. Under **Your desktops**, choose **Connect**. That action is available only for a relay-capable publication.

The host makes an outbound WebSocket connection to the desktop service. The browser connects to the same relay, which pairs it with that host after checking ownership. The browser does not need a direct route to the host's private address or a separate VNC-password prompt for this authenticated relay.

Mac relay publication still requires a running **Share This Mac** host with its Tailscale prerequisites. Linux can publish a relay while keeping its direct listener on loopback. The native Mac viewer currently uses direct endpoints; it does not connect to relay-only hosts through the browser transport.

## Permissions and features

Allowing someone to sign in does not share your computers with that person. Publication and relay access remain private to the owning account.

The host controls whether remote input, audio, clipboard, or file access is available. Features are negotiated per connection and depend on the host and viewer; generic VNC servers may provide only screen and input support. Audio and file sharing require explicit host configuration. The host process must remain running for either direct or relay connections.
