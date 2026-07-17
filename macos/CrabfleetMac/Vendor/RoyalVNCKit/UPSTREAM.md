# RoyalVNCKit fork provenance

Source: <https://github.com/royalapplications/royalvnc>

Upstream commit: `337197afdb32020d3dfdb7d058989115b740cdc4`

License: MIT; see `LICENSE`.

This macOS-only source fork removes demo and C SDK targets and carries narrow
defensive limits for remote-controlled strings, clipboard payloads, compressed
frame payloads, and framebuffer allocations. It also serializes shared queues
and connection state; replaces bundled d3des with per-call CommonCrypto DES
using the VNC bit-reversed-key variant; drops upstream's CryptoSwift dependency
in favor of CommonCrypto and CryptoKit plus an in-fork pure-Swift big integer
for Apple Remote Desktop Diffie-Hellman; suppresses clipboard echoes; releases
held input on focus loss; exposes externally managed clipboard delivery/send;
accepts an already-established Network.framework byte stream for Crabfleet's
SPKI-pinned QUIC transport and can account for its stream-opening RFB banner;
coalesces inbound clipboard delivery; paces framebuffer pulls; renders an
attached warm framebuffer immediately; negotiates RFB 3.3/3.7/3.8 security
framing; prefers supported Apple Remote Desktop authentication when macOS
Screen Sharing advertises it; validates palette ranges; and materializes bounded framebuffer
previews.

The fork also negotiates and decodes the community Open H.264 RFB frame
encoding (type 50) through VideoToolbox on supported Apple platforms, with
Annex-B parsing, decoder-context resets, and IDR recovery kept in one encoding.

The fork completes the upstream Extended Clipboard stub (pseudo-encoding
`0xc0a1e5ce`): the client advertises the extension when clipboard sync is
enabled, answers server caps, exchanges UTF-8 text through bounded
notify/request/provide flows with one-shot zlib coding, and transparently
falls back to Latin-1 cut text against servers without the extension. The
`VNCExtendedClipboard` codec is public so the application's own RFB host can
speak the same dialect. Keep product changes in the Crabfleet target; keep
this fork small and suitable for upstreaming.
