# WebRTC adapter

`crabfleet-rtc` is the independent client's platform transport, media, and Fluid session library. It does not sign in to the Jump account, discover computers, or deliver cloud signaling. The viewer's shared runtime connects it to the account layer and binds signaling to the selected peer/session.

Native Linux uses GStreamer's `webrtcbin`, `decodebin`, and media converters. Browser WASM uses `RTCPeerConnection`, a video element, an audio element, and a private canvas for RGBA extraction. Both implementations create an ordered reliable data channel labeled `rtc`. The library contains no vendor code, wrapper page, screen capture, or operating-system input injection.

## Contract

Use `connection::Connection` to combine WebRTC with Fluid host authentication, input/clipboard permissions, and media gating. It starts the host exchange when the control channel opens, requests desktop media after a view grant, mutes audio and withholds frames before authorization or after revocation, and releases held input when control is revoked. Local host credentials are supplied only when the session requests them. The caller chooses interactive host approval versus local host authentication; there is no anonymous fallback.

`commit_text()` sends bounded Unicode only when the peer advertises text injection support. Mac commits with at least two Unicode characters and Windows commits with at least two UTF-16 units receive one completed event, avoiding duplicate insertion. Shorter commits and unknown peer types receive a down/up pair. This distinction matters for a single emoji: Windows treats its surrogate pair as a whole string; Mac treats it as one character. `shortcut()` maps clipboard chords to Command on a Fluid Mac peer and Control otherwise, and also supports remote Escape/Caps Lock taps. `paste_text()` verifies control and clipboard access, sends bounded UTF-8 content, and follows it with the paste chord on the ordered control channel. The shared viewer releases its local capture state consistently with these operations. Local tests verify delivery and revocation; live Mac and Windows sessions verify Unicode typing and explicit clipboard round trips. Complex IME workflows remain unverified.

Pass monotonically increasing milliseconds to `Connection::poll()`. This bounds initial channel negotiation to 45 seconds and runs Fluid's 30-second ping/60-second peer timeout. The wrapper accepts at most 1024 decoded control messages per update, failing a peer that exceeds this work limit. Failures close the peer and are delivered once. New input after permission revocation is rejected. The UI must clear any previously uploaded texture when view permission is revoked or the connection ends. `close()` queues best-effort input releases before transport shutdown; the host must also release input on abrupt connection loss.

The lower-level `Peer` contract follows for adapter use and tests:

`session::Event::Cursor` carries the latest validated RGBA cursor and visibility state. Image subscriptions follow viewing permission, cache entries are bounded to 16 images/4 MiB, and late replies cannot change the selected ID. Each image is at most 512×512 with a validated hotspot and scale. Clear the displayed cursor on revocation or teardown along with the video texture. Native and browser clients share this control implementation; remote position tracking is not requested.

`Failure::NetworkLost` identifies a failed WebRTC connection or a disconnected state lasting at least five seconds. The shared viewer may retry a previously authorized host after that failure or a peer heartbeat timeout. Explicit control-channel closure, host termination, authentication failure, and invalid protocol data are terminal. `ConnectionUpdates::view_revoked` survives a later transport failure in the same update, preventing recovery from forgetting a host's permission revocation. An adapter network-loss event preserves earlier control messages and fences late media.

Create a `Peer` with the authenticated session's ICE servers, call `start()`, and regularly call `poll()`. Deliver `Description` and `Candidate` events through the session's signaling transport; feed only that session's remote messages to `set_remote_description()` and `add_candidate()`. Credentials and SDP are omitted from `Debug` output. Framework errors are reduced to local messages because their original text can include sensitive connection information.

When `ControlOpened` arrives, the caller starts the Fluid host authentication exchange. `send_control()` accepts length-delimited protocol bytes and fragments them into at most 16 KiB SCTP messages. Received `ControlData` events are stream chunks: feed them to `crabfleet_fluid::framing::Decoder`, rather than assuming each event is a whole Protocol Buffer.

`Updates.frame` retains only the newest decoded RGBA frame. The native adapter copies rows using the negotiated stride. The browser adapter uses `requestVideoFrameCallback`, with at most one pending callback, to copy new frames; Firefox's playback-quality counter stays at zero for live streams. Track replacement and teardown cancel the pending callback. Browsers must support both video frame callback methods. Browser audio playback may require a user gesture; invoke `set_audio_enabled(true)` from that gesture and handle `AudioPlaybackBlocked`. `audio_samples` counts decoded PCM sample frames on native builds and is zero in browser builds, where this metric is not collected.

Run native operations on a networking/media worker. `close()` is idempotent and clears callbacks' inbox access before releasing the pipeline. GStreamer teardown is local and synchronous; keep it off the UI thread. Polling an adapter failure closes the peer. A closed peer cannot be restarted: construct a fresh peer for reconnection. The caller owns negotiation/keepalive deadlines, input release, and signaling-session fencing.

Native answers preserve the established control transport's DTLS client/server role when the host adds bundled media. GStreamer 1.28 otherwise changes a passive endpoint to active when answering an `actpass` offer, which Chrome rejects. Only the corresponding `setup` attributes change; unbundled transports and certificate/ICE attributes remain intact. A conflicting explicit host role fails the connection.

Native transceivers advertise only receive pipelines that are present: VP8/VP9 with the VPX plugin, H.264 with the libav decoder and parser, and Opus. RTP depayloaders are required too. GStreamer does not infer these application capabilities by itself. A real answer-generation test offers both VP8 and unsupported AV1 and verifies that only VP8 is accepted. A later missing-plugin failure reports a fixed codec description without logging remote caps or credentials.

## Limits

- Each control chunk/message is at most 2 MiB; buffered outgoing control and retained event payloads each have a 4 MiB limit. Outgoing queue overflow fails the connection. Incoming events have a separate 128-event limit.
- SDP is limited to 256 KiB and nine media sections; ICE candidates are limited to 32 KiB, with at most 128 candidates pending a remote description. ICE server lists have at most 32 entries.
- GStreamer's native configuration uses the first supplied STUN server and all supplied TURN servers. The browser receives the complete server list.
- Video has at most 16,777,216 pixels and neither dimension may exceed 8192. These are application copy limits; GStreamer and browser codec/network buffers have their own internal allocation policies.
- Native peers admit at most eight incoming tracks over their lifetime. Browser output retains one video and one audio track, replacing and stopping earlier tracks of the same kind. Concurrent monitor presentation is not implemented.
- The initial proof exercises VP8 and Opus. Other codecs depend on installed GStreamer plugins or browser support and have not been verified. TURN URI mapping is unit-tested; relay traversal has not been tested live.

## Build and proof

Use the workspace Rust version and GStreamer 1.22 or newer. Native builds require the pkg-config development packages `gstreamer-1.0`, `gstreamer-app-1.0`, `gstreamer-video-1.0`, `gstreamer-sdp-1.0`, and `gstreamer-webrtc-1.0`. Runtime components include `webrtcbin`, libnice, DTLS/SRTP/SCTP, `decodebin`, `videoconvert`, `audioconvert`, `audioresample`, `volume`, and an audio sink. The local test also needs `videotestsrc`, `audiotestsrc`, VP8 and Opus encoders/decoders, and RTP payloaders/depayloaders.

Real Jump sessions additionally use the [native DTLS extension](../native-media/README.md), built against GStreamer 1.28+. It adds the AES-256-GCM SRTP profile observed on the real host. Run through `bash client/scripts/run-native.sh` after building the extension. On Arch Linux, the `gst-libav` package provides H.264 decoding; VP8/VP9 are available through the VPX plugin. Installing a codec alone does not replace correct negotiation.

From the repository root:

```bash
cargo test --locked --manifest-path client/Cargo.toml -p crabfleet-rtc
cargo clippy --locked --manifest-path client/Cargo.toml -p crabfleet-rtc --all-targets -- -D warnings
cargo clippy --locked --manifest-path client/Cargo.toml -p crabfleet-rtc --target wasm32-unknown-unknown -- -D warnings
```

The native integration tests start local peers without external signaling. One verifies bidirectional encrypted SCTP delivery with a fragmented Fluid message, checks a decoded red 320×180 VP8 frame, and counts decoded Opus samples through a silent sink. Another runs the combined session against a synthetic host: the initial offer contains only the data channel, the host grants interactive access, the client requests media and cursor images, the host renegotiates to add video/audio, the cursor and input reach their destinations, and a zero permission grant releases the held key, stops cursor updates, and blocks further input. The synthetic senders use explicit SSRCs and withhold RTP until the transceiver has a negotiated sending direction. This avoids a GStreamer 1.28.6 crash when new test media races its SDP on an already writable bundle; it is a fixture correction, not an upstream receiver fix. Tests also cover the negotiation deadline, idempotent teardown, and callback ownership. No Jump credentials, remote desktop, microphone, or screen capture is involved.

Browser adapter tests use the matching `wasm-bindgen-test` runner and a separate JavaScript WebRTC peer:

```bash
bash client/scripts/test-browser-rtc.sh
```

Open the printed loopback URL in a test browser and click **Start silent WebRTC test audio** when it appears. The normal browser gesture resumes an audio context that generates silence; no autoplay override, microphone, screen capture, account, STUN, or TURN service is used. The browser page reports pass/fail. The interactive server stays running until Ctrl+C, so its process exit code is not the test result. This follows the upstream [interactive browser test workflow](https://wasm-bindgen.github.io/wasm-bindgen/wasm-bindgen-test/browsers.html).

The WASM tests verify an initial data-only offer, a fragmented control message and echo over DTLS/SCTP, host-initiated renegotiation to add video/audio, a decoded red 320×180 frame even with a zero playback-quality counter, received Opus samples, muted playback, and idempotent shutdown that stops tracks and cancels the bounded frame callback. Another test closes the adapter with an offer promise pending and rejects late events. A third verifies that the service's redundant STUN `?transport=udp` hint is removed for browser construction, while TURN transports stay intact and unsupported STUN queries remain rejected. Its loopback addresses use port 3478 because Firefox blocks port 9. These execute the actual browser adapter; the generated-media fixture is only a local test peer. Linux browser fixtures need a working audio service; a PulseAudio null sink is sufficient for their generated silence.

An optional native-to-Chromium test starts the real Rust adapter against the same browser fixture. It verifies a 73 KiB fragmented encrypted control echo, browser-initiated media renegotiation, decoded red VP8 video and Opus audio, control delivery after media starts, mute switching, and teardown on both sides. It needs Node with Playwright resolvable through normal module lookup or `NODE_PATH`; set `CHROMIUM_EXECUTABLE` to an installed browser, or let Playwright use its own Chromium installation:

```bash
CHROMIUM_EXECUTABLE=/usr/bin/chromium cargo test --locked --manifest-path client/Cargo.toml -p crabfleet-rtc native_control_video_audio_with_real_chromium -- --ignored
```

The test uses an isolated headless browser, a loopback page, no external ICE servers, and private child-process pipes for signaling. Playwright clicks the normal audio activation button; audio is generated silence and the native sink is silent. It does not print SDP. It passed with Playwright 1.62.1 and Chrome 153.0.8010.36. This is a local interoperability check, not a Jump host session.

Verified with Rust 1.98.1 and GStreamer 1.28.6 on Linux, and all three WASM tests pass in visible Chrome 153.0.8010.36. Normal Jump account/MFA sign-in, discovery, host authentication, desktop video, pointer/Unicode keyboard input, view-only suppression, release, explicit clipboard transfer, and actual audio output pass on both targets against one personal Mac host. Browser recovery after gateway interruption also passes. The native media extension passes the Chromium test with an explicit AES-256-GCM profile assertion. Native acceptance against AWS Windows Server 2022 also verifies normal authentication, desktop video, exact Unicode typing and clipboard round trips, view-only rejection, and reconnect; Edge 148 and Firefox 154 pass all three updated browser adapter fixtures, including the zero playback-quality counter regression. The Firefox web interface also verifies the Windows desktop, exact text/clipboard contents, view-only controls, and manual reconnect. The Windows VM has no audio endpoint. Audible Windows-host playback, TURN-only traversal, complex IME behavior, and fully suspended browser recovery remain unverified.
