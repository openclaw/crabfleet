//! Same-origin HTTP and signaling transport for the independent WASM client.
//! Production upstreams are fixed; account and host authentication remain required.
mod relay;

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Request, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use crabfleet_cloud::{
    AUTH_URL, GATEWAY_AUTH_PATH, GATEWAY_PROTOCOL, GATEWAY_SIGNAL_PATH, SIGNAL_URL,
    auth::Credentials,
};
use futures_util::StreamExt;
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::{Semaphore, watch};
use zeroize::Zeroizing;

const MAX_AUTH_BODY: usize = 128 * 1024;
const MAX_AUTH_RESPONSE: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const AUTH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct Gateway(Arc<Inner>);
struct Inner {
    origin: String,
    authority: String,
    assets: Vec<Asset>,
    http: reqwest::Client,
    auth_url: String,
    signal_url: String,
    auth_slots: Arc<Semaphore>,
    socket_slots: Arc<Semaphore>,
    requests: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
}
struct Asset {
    path: &'static str,
    content_type: &'static str,
    bytes: Bytes,
}
impl Gateway {
    pub async fn new(origin: &str, assets: &Path) -> Result<Self, &'static str> {
        let (origin, authority) = parse_origin(origin)?;
        let mut loaded = Vec::new();
        for (name, content_type) in [
            ("index.html", "text/html; charset=utf-8"),
            ("main.js", "text/javascript; charset=utf-8"),
            ("pkg/crabfleet_viewer.js", "text/javascript; charset=utf-8"),
            ("pkg/crabfleet_viewer_bg.wasm", "application/wasm"),
        ] {
            let path = assets.join(name);
            let metadata = tokio::fs::metadata(&path)
                .await
                .map_err(|_| "Build the web app first: bash client/scripts/build-web.sh")?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ASSET_BYTES {
                return Err("Invalid web asset size");
            }
            let bytes = tokio::fs::read(path)
                .await
                .map_err(|_| "Could not read web assets")?;
            if bytes.len() as u64 > MAX_ASSET_BYTES {
                return Err("Web asset exceeds size limit");
            }
            loaded.push(Asset {
                path: name,
                content_type,
                bytes: bytes.into(),
            });
        }
        let http = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(AUTH_TIMEOUT)
            .connect_timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| "Could not initialize verified HTTPS transport")?;
        Ok(Self(Arc::new(Inner {
            origin,
            authority,
            assets: loaded,
            http,
            auth_url: AUTH_URL.into(),
            signal_url: SIGNAL_URL.into(),
            auth_slots: Arc::new(Semaphore::new(4)),
            socket_slots: Arc::new(Semaphore::new(8)),
            requests: Arc::new(Semaphore::new(32)),
            shutdown: watch::channel(false).0,
        })))
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route(
                "/api/health",
                get(|| async {
                    json(
                        StatusCode::OK,
                        br#"{"service":"crabfleet-web-gateway","version":1}"#.to_vec(),
                    )
                }),
            )
            .route(GATEWAY_AUTH_PATH, post(authenticate))
            .route(GATEWAY_SIGNAL_PATH, get(signaling))
            .fallback(get(asset))
            .layer(middleware::from_fn_with_state(self.clone(), boundary))
            .with_state(self.clone())
    }
    pub fn origin(&self) -> &str {
        &self.0.origin
    }
    pub fn stop(&self) {
        self.0.shutdown.send_replace(true);
    }
}

fn parse_origin(value: &str) -> Result<(String, String), &'static str> {
    let url = url::Url::parse(value).map_err(|_| "Invalid public origin")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("Origin must be HTTPS, or HTTP on localhost, with no credentials or path");
    }
    let origin = url.origin().ascii_serialization();
    let authority = origin
        .split_once("://")
        .ok_or("Invalid origin")?
        .1
        .to_owned();
    Ok((origin, authority))
}

async fn boundary(State(gateway): State<Gateway>, request: Request, next: Next) -> Response {
    let mut shutdown = gateway.0.shutdown.subscribe();
    let result = if *shutdown.borrow() {
        error(StatusCode::SERVICE_UNAVAILABLE)
    } else if !valid_host(request.headers(), &gateway.0.authority) {
        error(StatusCode::MISDIRECTED_REQUEST)
    } else if request.uri().path().starts_with("/api/") && request.uri().query().is_some() {
        error(StatusCode::BAD_REQUEST)
    } else if (request.method() == Method::POST || request.uri().path() == GATEWAY_SIGNAL_PATH)
        && !valid_origin(request.headers(), &gateway.0.origin)
    {
        error(StatusCode::FORBIDDEN)
    } else if let Ok(_permit) = gateway.0.requests.clone().try_acquire_owned() {
        tokio::select! {
            _ = shutdown.changed() => error(StatusCode::SERVICE_UNAVAILABLE),
            response = tokio::time::timeout(REQUEST_TIMEOUT, next.run(request)) => response.unwrap_or_else(|_| error(StatusCode::REQUEST_TIMEOUT)),
        }
    } else {
        error(StatusCode::TOO_MANY_REQUESTS)
    };
    secure_headers(result)
}
fn valid_host(headers: &HeaderMap, authority: &str) -> bool {
    headers.get_all(header::HOST).iter().count() == 1
        && headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case(authority))
}
fn valid_origin(headers: &HeaderMap, origin: &str) -> bool {
    headers.get_all(header::ORIGIN).iter().count() == 1
        && headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) == Some(origin)
        && headers
            .get("sec-fetch-site")
            .is_none_or(|value| value == "same-origin")
}
fn secure_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cross-origin-resource-policy", "same-origin"),
        ("cross-origin-opener-policy", "same-origin"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:9001 ws://localhost:9001; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}
fn json(status: StatusCode, bytes: Vec<u8>) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], bytes).into_response()
}
fn error(status: StatusCode) -> Response {
    json(
        status,
        br#"{"errors":[{"code":"gateway-request-failed"}]}"#.to_vec(),
    )
}
async fn asset(State(gateway): State<Gateway>, uri: Uri) -> Response {
    let path = match uri.path() {
        "/" => "index.html",
        other => other.trim_start_matches('/'),
    };
    match gateway.0.assets.iter().find(|asset| asset.path == path) {
        Some(asset) => (
            [(header::CONTENT_TYPE, asset.content_type)],
            Body::from(asset.bytes.clone()),
        )
            .into_response(),
        None => error(StatusCode::NOT_FOUND),
    }
}
async fn authenticate(State(gateway): State<Gateway>, request: Request) -> Response {
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/json")
    {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let Ok(_permit) = gateway.0.auth_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS);
    };
    let bytes = match to_bytes(request.into_body(), MAX_AUTH_BODY).await {
        Ok(bytes) => Zeroizing::new(bytes.to_vec()),
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE),
    };
    let credentials = match serde_json::from_slice::<Credentials>(&bytes) {
        Ok(credentials) => credentials,
        Err(_) => return error(StatusCode::BAD_REQUEST),
    };
    let body = match credentials.request_body() {
        Ok(body) => body,
        Err(_) => return error(StatusCode::BAD_REQUEST),
    };
    drop(credentials);
    drop(bytes);
    match upstream_auth(&gateway.0, &body).await {
        Ok((status, response)) => json(status, response),
        Err(status) => error(status),
    }
}
async fn upstream_auth(gateway: &Inner, body: &[u8]) -> Result<(StatusCode, Vec<u8>), StatusCode> {
    let response = gateway
        .http
        .post(&gateway.auth_url)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();
    if status.is_redirection()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_AUTH_RESPONSE as u64)
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if chunk.len() > MAX_AUTH_RESPONSE.saturating_sub(bytes.len()) {
            return Err(StatusCode::BAD_GATEWAY);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, bytes))
}
async fn signaling(
    State(gateway): State<Gateway>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        != Some(GATEWAY_PROTOCOL)
    {
        return error(StatusCode::BAD_REQUEST);
    }
    let Ok(permit) = gateway.0.socket_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS);
    };
    upgrade
        .protocols([GATEWAY_PROTOCOL])
        .max_message_size(relay::MAX_MESSAGE)
        .max_frame_size(relay::MAX_MESSAGE)
        .write_buffer_size(0)
        .max_write_buffer_size(relay::MAX_BUFFERED)
        .on_upgrade(move |socket| relay::run(socket, gateway, permit))
}

#[cfg(test)]
mod tests;
