# Native DTLS media extension

The live browser session negotiated `SRTP_AEAD_AES_256_GCM`. GStreamer 1.28.6's DTLS plugin advertises only `SRTP_AES128_CM_SHA1_80`, although its SRTP plugin already supports AES-GCM. This extension joins those existing OpenSSL and libSRTP implementations using the negotiated profile's key and salt lengths. It retains authenticated DTLS, SRTP replay protection, and the standard 128-bit GCM authentication tag.

`sources.json` pins SHA-256 checksums for the [GStreamer 1.28.6 DTLS sources](https://github.com/GStreamer/gstreamer/tree/1.28.6/subprojects/gst-plugins-bad/ext/dtls). `aead-srtp.patch` adds both RFC 7714 GCM profiles, retains the existing AES-128 profile, and removes secret key values from two upstream informational log messages. Unsupported profiles fail the handshake. This is a local compatibility patch, not an upstream release.

Build with Python 3, a C compiler, `patch`, `pkg-config`, GStreamer 1.28+ development files, and OpenSSL 1.1.1+ development files:

```sh
python3 client/native-media/build.py
bash client/scripts/run-native.sh
```

The build downloads only the checksum-pinned source files and writes under `client/target/native-media`. `--offline` requires the verified sources to be cached already. The launcher selects the extension and a separate plugin registry for this process. It does not install or replace system libraries. Runtime GStreamer SRTP, SCTP, libnice, codecs, and audio output plugins are still required.

The source files retain their upstream BSD license headers. Any binary redistribution must include their copyright notices, license conditions, and disclaimers. Packaging and redistribution remain pending.

Local native-to-native media tests and a real Chromium peer have passed with this extension. The Chromium test explicitly confirmed `SRTP_AEAD_AES_256_GCM`, decoded VP8 and Opus, exchanged control before and after media renegotiation, and closed both peers. The actual Linux viewer completed normal real-host authentication and displayed sustained desktop video after restricting RTP negotiation to installed receive pipelines. Pointer/Unicode keyboard input, view-only suppression, explicit clipboard transfer, and audio playback also pass against the tested Mac host; the native acceptance harness additionally verifies Windows Server 2022 video, Unicode input, clipboard, view-only rejection, and reconnect. The AWS Windows image has no audio endpoint. See the [compatibility evidence and limits](../docs/jump-interoperability.md).

```sh
GST_PLUGIN_PATH="$PWD/client/target/native-media" \
GST_REGISTRY="$PWD/client/target/native-media/registry.bin" \
CRABFLEET_TEST_SRTP_PROFILE=SRTP_AEAD_AES_256_GCM \
NODE_PATH=/path/to/node_modules \
CHROMIUM_EXECUTABLE=/path/to/chromium \
cargo test --locked --manifest-path client/Cargo.toml -p crabfleet-rtc \
  native_control_video_audio_with_real_chromium -- --ignored --nocapture
```
