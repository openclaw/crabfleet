# Web gateway

`crabfleet-web-gateway` serves our independent WASM client and supplies its same-origin account and signaling transport. It uses Axum 0.8.9 and Tokio. Native Linux clients continue to connect directly to Jump; browser WebRTC video, audio, and Fluid control stay between the browser and the selected host. No vendor web application is embedded or served.

The gateway is necessary because a public preflight to Jump's account endpoint did not permit our local app origin. It performs normal server-to-server HTTPS and WSS requests to the two fixed service endpoints. It neither supplies a vendor Origin header nor changes the user's account or host authentication requirements. **Live Chrome sessions verify password/MFA sign-in, discovery, host authentication, desktop video/input, audio output, explicit clipboard transfer, and recovery after a gateway restart against the tested Mac host.** Provider/SSO sign-in and broader host compatibility remain unfinished.

## Run

From the repository root, build the web client and start the gateway:

```bash
bash client/scripts/build-web.sh
cargo run --locked --manifest-path client/Cargo.toml -p crabfleet-web-gateway
```

Open the printed address, normally `http://127.0.0.1:8093`. Use that exact hostname; Host and Origin checks are intentional. The default assets directory is the checkout's `client/dist`; override it with `--assets DIR` when moving the binary. Stop with Ctrl+C. The gateway itself does not need GStreamer.

`--listen 127.0.0.1:PORT` selects a different loopback port. For use behind your own HTTPS reverse proxy, set `--origin https://desktop.example` and preserve the original Host/Origin headers and WebSocket upgrades. The listener remains on loopback. TLS termination and access policy belong to that deployment; no public deployment is included here. Run the gateway on infrastructure you trust: login credentials and account signaling pass through it. Payloads are not logged or persisted, account tokens remain in browser memory, and HTTP/network libraries hold transient buffers.

## Transport contract

The browser's authentication request explicitly selects the `same-origin` referrer policy. Inheriting the page's `no-referrer` policy makes Firefox send `Origin: null` for a same-origin POST, which the gateway rejects. The request still rejects redirects and cross-origin destinations; the gateway continues to reject missing, null, and mismatched origins and does not forward browser referrers upstream.

`POST /api/jump/auth` accepts the shared `Credentials` JSON shape: `email`, `password`, and optional `passcode`, `recoveryCode`, and `captcha`. Unknown fields are rejected. The gateway validates field bounds, uses the existing `api-all` request with device-token revocation disabled, and forwards the bounded response status/body. Password/MFA/challenge handling remains in the shared account model. Browser cookies, authorization headers, and Origin are not forwarded; upstream cookies and headers are not returned. HTTPS certificates are verified and redirects rejected.

`GET /api/jump/signaling` requires the `crabfleet-jump-signaling-v1` WebSocket subprotocol and the configured app origin. It waits for the browser's first binary account message before opening the fixed upstream WSS connection, then forwards binary chunks in order. Fragmented discovery and peer signaling remain owned by the existing protocol implementation. Policy-close codes are preserved; close reasons are omitted. A socket is closed when either side ends or the gateway stops.

`GET /api/health` reports only the gateway name and protocol version. The loader checks this before starting the normal viewer; `?demo=1` also works under an ordinary static server while the separate synthetic demo server is running. Static routes expose only the four built app assets, with explicit MIME types, no caching, and a content security policy. No directory listing or arbitrary upstream URL is available.

## Bounds and proof

There are at most four concurrent authentication requests, eight upgraded signaling sockets, and 32 active HTTP handlers. Authentication request JSON is limited to 128 KiB, decoded credential fields retain their individual limits, and responses are limited to 1 MiB. An authentication request has a 20-second upstream deadline and a 25-second handler deadline. WebSockets allow messages of at most 2 MiB plus framing, 4 MiB write buffers, and five-second sends. The gateway sends browser pings every 30 seconds and stops after 90 seconds without browser activity or 180 seconds without upstream activity. Initial client authentication and upstream connection waits are bounded. Assets are loaded once, with a 64 MiB limit per file.

```bash
cargo test --locked --manifest-path client/Cargo.toml -p crabfleet-web-gateway
cargo clippy --locked --manifest-path client/Cargo.toml -p crabfleet-web-gateway --all-targets -- -D warnings
```

Six tests exercise actual loopback HTTP and WebSockets: password/MFA responses, fixed request normalization, header isolation, origin/Host/schema/size/concurrency rejection, fragmented discovery, peer routing, policy-close handling, idle-socket shutdown, and cancellation during an upstream upgrade. A separate smoke check has started the compiled gateway and verified all four served assets against the built files. A live Chrome session received more than 12,600 real-host frames before a gateway interruption. Restarting the gateway restored signaling and the selected computer without another account password/MFA entry; normal host credentials were requested again, and desktop video resumed. See the [full compatibility evidence](../docs/jump-interoperability.md).
