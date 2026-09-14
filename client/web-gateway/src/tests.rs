use super::*;
use axum::extract::ws::{Message, WebSocket};
use crabfleet_cloud::{
    auth::Secret,
    service::{self, Service},
};
use crabfleet_fluid::{
    discovery::{Announcement, ServerInfo, ServerList},
    framing, signaling,
};
use futures_util::SinkExt;
use std::{
    net::SocketAddr,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as ClientMessage, client::IntoClientRequest},
};

struct TestServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn serve(listener: TcpListener, app: Router) -> TestServer {
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    TestServer { address, task }
}
async fn launch(upstream: SocketAddr) -> (Gateway, TestServer) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let authority = listener.local_addr().unwrap().to_string();
    let gateway = Gateway(Arc::new(Inner {
        origin: format!("http://{authority}"),
        authority,
        assets: vec![Asset {
            path: "index.html",
            content_type: "text/html",
            bytes: Bytes::from_static(b"synthetic viewer asset"),
        }],
        http: reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap(),
        auth_url: format!("http://{upstream}/auth"),
        signal_url: format!("ws://{upstream}/signal"),
        auth_slots: Arc::new(Semaphore::new(4)),
        socket_slots: Arc::new(Semaphore::new(8)),
        requests: Arc::new(Semaphore::new(32)),
        shutdown: watch::channel(false).0,
    }));
    let server = serve(listener, gateway.router()).await;
    (gateway, server)
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}
fn credentials() -> Credentials {
    Credentials {
        email: "synthetic@example.test".into(),
        password: Secret::new("synthetic-password".into()),
        passcode: None,
        recovery_code: None,
        captcha: None,
    }
}
fn browser_request(gateway: &Gateway) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut request = format!(
        "{}{GATEWAY_SIGNAL_PATH}",
        gateway.origin().replacen("http:", "ws:", 1)
    )
    .into_client_request()
    .unwrap();
    request
        .headers_mut()
        .insert("Origin", gateway.origin().parse().unwrap());
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", GATEWAY_PROTOCOL.parse().unwrap());
    request
}

async fn login(State(count): State<Arc<AtomicUsize>>, headers: HeaderMap, body: Bytes) -> Response {
    assert!(!headers.contains_key("origin"));
    assert!(!headers.contains_key("cookie"));
    assert!(!headers.contains_key("authorization"));
    let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(request["scope"], "api-all");
    assert_eq!(request["revokePreviousDeviceTokens"], false);
    assert_eq!(request["neuronId"], "");
    count.fetch_add(1, Ordering::SeqCst);
    if request["email"] == "oversized@example.test" {
        return vec![b'x'; MAX_AUTH_RESPONSE + 1].into_response();
    }
    let response = if request["passcode"] == "123456" {
        json(
            StatusCode::OK,
            br#"{"token":"synthetic-account-token","email":"synthetic@example.test"}"#.to_vec(),
        )
    } else {
        json(
            StatusCode::UNAUTHORIZED,
            br#"{"errors":[{"code":"passcode-required"}]}"#.to_vec(),
        )
    };
    let mut response = response;
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("synthetic=unused"),
    );
    response
}

#[tokio::test]
async fn password_mfa_and_static_assets_roundtrip_through_the_same_origin_gateway() {
    let count = Arc::new(AtomicUsize::new(0));
    let upstream = serve(
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        Router::new()
            .route("/auth", post(login))
            .with_state(count.clone()),
    )
    .await;
    let (gateway, _server) = launch(upstream.address).await;
    let http = client();
    let index = http.get(gateway.origin()).send().await.unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert_eq!(index.headers()["cache-control"], "no-store");
    assert!(
        index.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    assert_eq!(index.text().await.unwrap(), "synthetic viewer asset");
    let mut credentials = credentials();
    for status in [StatusCode::UNAUTHORIZED, StatusCode::OK] {
        let response = http
            .post(format!("{}{GATEWAY_AUTH_PATH}", gateway.origin()))
            .header("Origin", gateway.origin())
            .header("Content-Type", "application/json")
            .header("Cookie", "synthetic=must-not-forward")
            .body(serde_json::to_vec(&credentials).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert!(!response.headers().contains_key("set-cookie"));
        assert_eq!(response.headers()["cache-control"], "no-store");
        let result: serde_json::Value =
            serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        if status == StatusCode::OK {
            assert_eq!(result["token"], "synthetic-account-token");
        } else {
            assert_eq!(result["errors"][0]["code"], "passcode-required");
        }
        credentials.passcode = Some(Secret::new("123456".into()));
    }
    assert_eq!(count.load(Ordering::SeqCst), 2);
    gateway.stop();
}

#[tokio::test]
async fn origin_host_schema_size_and_capacity_checks_run_before_upstream_auth() {
    let count = Arc::new(AtomicUsize::new(0));
    let upstream = serve(
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        Router::new()
            .route("/auth", post(login))
            .with_state(count.clone()),
    )
    .await;
    let (gateway, _server) = launch(upstream.address).await;
    let http = client();
    let body = serde_json::to_vec(&credentials()).unwrap();
    for (origin, host, content_type, path, bytes, status) in [
        (
            "null",
            gateway.0.authority.as_str(),
            "application/json",
            GATEWAY_AUTH_PATH,
            body.clone(),
            StatusCode::FORBIDDEN,
        ),
        (
            "https://unrelated.example",
            gateway.0.authority.as_str(),
            "application/json",
            GATEWAY_AUTH_PATH,
            body.clone(),
            StatusCode::FORBIDDEN,
        ),
        (
            gateway.origin(),
            "unrelated.example",
            "application/json",
            GATEWAY_AUTH_PATH,
            body.clone(),
            StatusCode::MISDIRECTED_REQUEST,
        ),
        (
            gateway.origin(),
            gateway.0.authority.as_str(),
            "text/plain",
            GATEWAY_AUTH_PATH,
            body.clone(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            gateway.origin(),
            gateway.0.authority.as_str(),
            "application/json",
            "/api/jump/auth?url=https://unrelated.example",
            body.clone(),
            StatusCode::BAD_REQUEST,
        ),
        (
            gateway.origin(),
            gateway.0.authority.as_str(),
            "application/json",
            GATEWAY_AUTH_PATH,
            vec![b'x'; MAX_AUTH_BODY + 1],
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            gateway.origin(),
            gateway.0.authority.as_str(),
            "application/json",
            GATEWAY_AUTH_PATH,
            br#"{"email":"a","password":"b","revokePreviousDeviceTokens":true}"#.to_vec(),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = http
            .post(format!("{}{path}", gateway.origin()))
            .header("Origin", origin)
            .header("Host", host)
            .header("Content-Type", content_type)
            .body(bytes)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let response = http
        .post(format!("{}{GATEWAY_AUTH_PATH}", gateway.origin()))
        .header("Content-Type", "application/json")
        .body(body.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let busy = gateway
        .0
        .auth_slots
        .clone()
        .acquire_many_owned(4)
        .await
        .unwrap();
    let response = http
        .post(format!("{}{GATEWAY_AUTH_PATH}", gateway.origin()))
        .header("Origin", gateway.origin())
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    drop(busy);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let mut oversized = credentials();
    oversized.email = "oversized@example.test".into();
    let response = http
        .post(format!("{}{GATEWAY_AUTH_PATH}", gateway.origin()))
        .header("Origin", gateway.origin())
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&oversized).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(response.bytes().await.unwrap().len() < 128);
    gateway.stop();
}

async fn signaling_peer(mut socket: WebSocket) {
    let Some(Ok(Message::Binary(bytes))) = socket.recv().await else {
        panic!("Missing account connect")
    };
    let mut decoder = framing::Decoder::default();
    decoder.push(&bytes).unwrap();
    let request = decoder
        .next_message::<signaling::ClientMessage>()
        .unwrap()
        .unwrap();
    assert_eq!(request.connect.unwrap().tokens, ["synthetic-account-token"]);
    let mut announcement = framing::encode(&signaling::ServerMessage {
        connected: Some(signaling::Connected::default()),
        ..Default::default()
    })
    .unwrap();
    announcement.extend(
        framing::encode(&signaling::ServerMessage {
            presence: Some(signaling::Presence {
                id: Some("synthetic-host".into()),
                online: Some(true),
                info: Some(
                    framing::encode(&Announcement {
                        server_list: Some(ServerList {
                            servers: vec![ServerInfo {
                                protocol: Some(3),
                                name: Some("Synthetic host".into()),
                                ..Default::default()
                            }],
                            connect_methods: vec![2],
                        }),
                    })
                    .unwrap(),
                ),
            }),
            ..Default::default()
        })
        .unwrap(),
    );
    socket
        .send(Message::Binary(announcement[..1].to_vec().into()))
        .await
        .unwrap();
    socket
        .send(Message::Binary(announcement[1..].to_vec().into()))
        .await
        .unwrap();
    let Some(Ok(Message::Binary(bytes))) = socket.recv().await else {
        panic!("Missing peer signal")
    };
    decoder.push(&bytes).unwrap();
    let send = decoder
        .next_message::<signaling::ClientMessage>()
        .unwrap()
        .unwrap()
        .send
        .unwrap();
    assert_eq!(send.to_id.as_deref(), Some("synthetic-host"));
    socket
        .send(Message::Binary(
            framing::encode(&signaling::ServerMessage {
                incoming: Some(signaling::Incoming {
                    from_id: Some("synthetic-host".into()),
                    data: send.data,
                    peer_unauthorized_to_send: Some(false),
                }),
                ..Default::default()
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    // A policy close must keep its meaning through the gateway.
    socket
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code: 1008,
            reason: "".into(),
        })))
        .await
        .unwrap();
}

#[tokio::test]
async fn signaling_preserves_fragmented_discovery_peer_routing_and_policy_close() {
    let upstream = serve(
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        Router::new().route(
            "/signal",
            get(|headers: HeaderMap, ws: WebSocketUpgrade| async move {
                assert!(!headers.contains_key("origin"));
                assert!(!headers.contains_key("cookie"));
                ws.on_upgrade(signaling_peer)
            }),
        ),
    )
    .await;
    let (gateway, _server) = launch(upstream.address).await;
    let (mut socket, handshake) = connect_async(browser_request(&gateway)).await.unwrap();
    assert_eq!(
        handshake.headers()["sec-websocket-protocol"],
        GATEWAY_PROTOCOL
    );
    let mut service = Service::new(Secret::new("synthetic-account-token".into()), 0).unwrap();
    socket
        .send(ClientMessage::Binary(service.opened().unwrap().into()))
        .await
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while service.directory().get("synthetic-host").is_none() {
            let ClientMessage::Binary(bytes) = socket.next().await.unwrap().unwrap() else {
                panic!("Missing discovery")
            };
            service.receive(&bytes, 1).unwrap();
        }
    })
    .await
    .unwrap();
    service.bind_computer("synthetic-host").unwrap();
    let signal = signaling::PeerMessage {
        sdp: Some(signaling::SessionDescription {
            sdp_type: Some("offer".into()),
            sdp: Some("synthetic SDP".into()),
            unified_plan: Some(true),
        }),
        ..Default::default()
    };
    socket
        .send(ClientMessage::Binary(
            service.signal(signal).unwrap().into(),
        ))
        .await
        .unwrap();
    let ClientMessage::Binary(bytes) = timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("Missing routed signal")
    };
    assert!(matches!(
        service.receive(&bytes, 2).unwrap().as_slice(),
        [service::Event::Signal(_)]
    ));
    let ClientMessage::Close(Some(close)) = timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("Missing close")
    };
    assert_eq!(u16::from(close.code), 1008);
    gateway.stop();
    let _all_closed = timeout(
        Duration::from_secs(2),
        gateway.0.socket_slots.clone().acquire_many_owned(8),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn websocket_requires_our_origin_and_protocol_and_shutdown_releases_idle_sessions() {
    let unused = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (gateway, _server) = launch(unused.local_addr().unwrap()).await;
    for wrong_origin in [true, false] {
        let mut request = browser_request(&gateway);
        if wrong_origin {
            request
                .headers_mut()
                .insert("Origin", "https://unrelated.example".parse().unwrap());
        } else {
            request.headers_mut().remove("Sec-WebSocket-Protocol");
        }
        assert!(connect_async(request).await.is_err());
    }
    let (mut socket, _) = connect_async(browser_request(&gateway)).await.unwrap();
    // No account message means no upstream connection is opened.
    assert!(
        timeout(Duration::from_millis(30), unused.accept())
            .await
            .is_err()
    );
    gateway.stop();
    let _ = timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap();
    let _all_closed = timeout(
        Duration::from_secs(2),
        gateway.0.socket_slots.clone().acquire_many_owned(8),
    )
    .await
    .unwrap()
    .unwrap();
}

#[test]
fn public_origin_cannot_include_credentials_paths_or_unencrypted_remote_hosts() {
    assert_eq!(
        parse_origin("http://127.0.0.1:8093").unwrap().1,
        "127.0.0.1:8093"
    );
    assert_eq!(
        parse_origin("https://desktop.example/").unwrap().0,
        "https://desktop.example"
    );
    for origin in [
        "http://desktop.example",
        "https://user:password@desktop.example",
        "https://desktop.example/path",
        "https://desktop.example/?token=value",
        "https://desktop.example/#fragment",
        "file:///tmp/index.html",
    ] {
        assert!(parse_origin(origin).is_err());
    }
}

#[tokio::test]
async fn browser_close_cancels_a_pending_upstream_upgrade() {
    use tokio::io::AsyncReadExt;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (gateway, _server) = launch(listener.local_addr().unwrap()).await;
    let (mut browser, _) = connect_async(browser_request(&gateway)).await.unwrap();
    browser
        .send(ClientMessage::Binary(vec![1].into()))
        .await
        .unwrap();
    let (mut upstream, _) = timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut headers = [0u8; 4096];
    assert!(
        timeout(Duration::from_secs(2), upstream.read(&mut headers))
            .await
            .unwrap()
            .unwrap()
            > 0
    );
    browser.close(None).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), upstream.read(&mut headers))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    let _all_closed = timeout(
        Duration::from_secs(2),
        gateway.0.socket_slots.clone().acquire_many_owned(8),
    )
    .await
    .unwrap()
    .unwrap();
    gateway.stop();
}
