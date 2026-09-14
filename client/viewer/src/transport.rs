use crabfleet_client_core::{Frame, Input, Message, Session, State};
use eframe::egui;
use std::sync::{Arc, Mutex};

pub const DEFAULT_ENDPOINT: &str = "ws://127.0.0.1:9001/demo";
pub const SUBPROTOCOL: &str = "crabfleet-demo-v1";

pub fn endpoint(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "Enter a valid loopback WebSocket URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !local
        || url.scheme() != "ws"
        || url.path() != "/demo"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "This build connects only to the local demo server: ws://127.0.0.1:9001/demo".into(),
        );
    }
    Ok(url)
}

pub struct Snapshot {
    pub frame: Option<Frame>,
    pub state: State,
    pub received: u64,
    pub bytes: u64,
    pub superseded: u64,
}

struct Inbox {
    session: Session,
    generation: u64,
    latest: Option<Frame>,
    superseded: u64,
}

impl Inbox {
    fn new() -> Self {
        let mut session = Session::default();
        let generation = session.begin();
        Self {
            session,
            generation,
            latest: None,
            superseded: 0,
        }
    }
    fn receive(&mut self, bytes: &[u8]) {
        match Message::decode(bytes)
            .and_then(|message| self.session.accept(self.generation, message))
        {
            Ok(Some(frame)) => {
                if self.latest.replace(frame).is_some() {
                    self.superseded += 1;
                }
            }
            Ok(None) => {}
            Err(error) => self.fail(&error.to_string()),
        }
    }
    fn fail(&mut self, reason: &str) {
        self.session.fail(reason);
        self.latest = None;
    }
    fn snapshot(&mut self) -> Snapshot {
        Snapshot {
            frame: self.latest.take(),
            state: self.session.state.clone(),
            received: self.session.frames,
            bytes: self.session.bytes,
            superseded: self.superseded,
        }
    }
}

type Shared = Arc<Mutex<Inbox>>;
fn fail(inbox: &Shared, ctx: &egui::Context, reason: &str) {
    inbox.lock().unwrap().fail(reason);
    ctx.request_repaint();
}

#[cfg(not(target_arch = "wasm32"))]
mod platform {
    use super::*;
    use crabfleet_client_core::{CAPABILITIES, MAX_MESSAGE};
    use std::{
        io::ErrorKind,
        net::TcpStream,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc::{SyncSender, sync_channel},
        },
        thread,
        time::Duration,
    };
    use tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig};

    pub struct Connection {
        inbox: Shared,
        outgoing: SyncSender<Vec<u8>>,
        alive: Arc<AtomicBool>,
    }
    fn pending(error: &tungstenite::Error) -> bool {
        matches!(error, tungstenite::Error::Io(error) if error.kind() == ErrorKind::WouldBlock)
    }
    impl Connection {
        pub fn open(value: &str, ctx: egui::Context) -> Result<Self, String> {
            let url = endpoint(value)?;
            let inbox = Arc::new(Mutex::new(Inbox::new()));
            let alive = Arc::new(AtomicBool::new(true));
            let (outgoing, receiver) = sync_channel::<Vec<u8>>(128);
            let shared = inbox.clone();
            let running = alive.clone();
            thread::Builder::new()
                .name("crabfleet-demo-transport".into())
                .spawn(move || {
                    let result = (|| -> Result<(), String> {
                        let address = url
                            .socket_addrs(|| Some(9001))
                            .map_err(|_| "Could not resolve loopback endpoint")?
                            .into_iter()
                            .find(|address| address.ip().is_loopback())
                            .ok_or("Endpoint is not loopback")?;
                        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
                            .map_err(|_| "Local demo server is unavailable")?;
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .map_err(|_| "Cannot configure socket")?;
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .map_err(|_| "Cannot configure socket")?;
                        stream
                            .set_nodelay(true)
                            .map_err(|_| "Cannot configure socket")?;
                        let mut request = url
                            .as_str()
                            .into_client_request()
                            .map_err(|_| "Invalid WebSocket request")?;
                        request
                            .headers_mut()
                            .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
                        let config = WebSocketConfig::default()
                            .max_message_size(Some(MAX_MESSAGE))
                            .max_frame_size(Some(MAX_MESSAGE))
                            .write_buffer_size(0)
                            .max_write_buffer_size(256 * 1024);
                        let (mut socket, response) =
                            tungstenite::client::client_with_config(request, stream, Some(config))
                                .map_err(|_| "Demo WebSocket handshake failed")?;
                        if response
                            .headers()
                            .get("Sec-WebSocket-Protocol")
                            .and_then(|value| value.to_str().ok())
                            != Some(SUBPROTOCOL)
                        {
                            return Err("Server did not negotiate the demo protocol".into());
                        }
                        socket
                            .send(tungstenite::Message::Binary(
                                Message::Hello(CAPABILITIES).encode().unwrap().into(),
                            ))
                            .map_err(|_| "Could not negotiate demo capabilities")?;
                        socket
                            .get_mut()
                            .set_nonblocking(true)
                            .map_err(|_| "Cannot configure socket")?;
                        while running.load(Ordering::Relaxed) {
                            for bytes in receiver.try_iter().take(32) {
                                if let Err(error) =
                                    socket.write(tungstenite::Message::Binary(bytes.into()))
                                    && !pending(&error)
                                {
                                    return Err(
                                        "Input transport closed or exceeded its buffer limit"
                                            .into(),
                                    );
                                }
                            }
                            if let Err(error) = socket.flush()
                                && !pending(&error)
                            {
                                return Err("Input transport closed".into());
                            }
                            for _ in 0..8 {
                                match socket.read() {
                                    Ok(tungstenite::Message::Binary(bytes)) => {
                                        let mut inbox = shared.lock().unwrap();
                                        inbox.receive(&bytes);
                                        if matches!(inbox.session.state, State::Failed(_)) {
                                            return Ok(());
                                        }
                                        drop(inbox);
                                        ctx.request_repaint();
                                    }
                                    Ok(tungstenite::Message::Close(_)) => {
                                        return Err("Demo server disconnected".into());
                                    }
                                    Ok(tungstenite::Message::Text(_)) => {
                                        return Err("Expected binary demo messages".into());
                                    }
                                    Ok(_) => {}
                                    Err(error) if pending(&error) => break,
                                    Err(_) => {
                                        return Err(
                                            "Demo transport closed or received invalid data".into(),
                                        );
                                    }
                                }
                            }
                            thread::sleep(Duration::from_millis(4));
                        }
                        let _ = socket.close(None);
                        Ok(())
                    })();
                    if let Err(reason) = result {
                        fail(&shared, &ctx, &reason);
                    }
                })
                .map_err(|_| "Cannot start transport thread")?;
            Ok(Self {
                inbox,
                outgoing,
                alive,
            })
        }
        pub fn send(&self, input: Input) -> Result<(), String> {
            let bytes = Message::Input(input)
                .encode()
                .map_err(|error| error.to_string())?;
            self.outgoing
                .try_send(bytes)
                .map_err(|_| "Input queue is full or disconnected".into())
        }
        pub fn snapshot(&self) -> Snapshot {
            self.inbox.lock().unwrap().snapshot()
        }
    }
    impl Drop for Connection {
        fn drop(&mut self) {
            self.alive.store(false, Ordering::Relaxed);
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod platform {
    use super::*;
    use crabfleet_client_core::{CAPABILITIES, MAX_MESSAGE};
    use wasm_bindgen::{JsCast, closure::Closure};
    use web_sys::{Event, MessageEvent, WebSocket};

    pub struct Connection {
        socket: WebSocket,
        inbox: Shared,
        _open: Closure<dyn FnMut(Event)>,
        _message: Closure<dyn FnMut(MessageEvent)>,
        _error: Closure<dyn FnMut(Event)>,
        _close: Closure<dyn FnMut(Event)>,
    }
    impl Connection {
        pub fn open(value: &str, ctx: egui::Context) -> Result<Self, String> {
            let url = endpoint(value)?;
            let socket = WebSocket::new_with_str(url.as_str(), SUBPROTOCOL)
                .map_err(|_| "Browser could not create the local demo connection")?;
            socket.set_binary_type(web_sys::BinaryType::Arraybuffer);
            let inbox = Arc::new(Mutex::new(Inbox::new()));
            let peer = socket.clone();
            let shared = inbox.clone();
            let context = ctx.clone();
            let open = Closure::wrap(Box::new(move |_: Event| {
                if peer.protocol() != SUBPROTOCOL
                    || peer
                        .send_with_u8_array(&Message::Hello(CAPABILITIES).encode().unwrap())
                        .is_err()
                {
                    fail(
                        &shared,
                        &context,
                        "Server did not negotiate the demo protocol",
                    );
                    let _ = peer.close();
                }
            }) as Box<dyn FnMut(Event)>);
            let peer = socket.clone();
            let shared = inbox.clone();
            let context = ctx.clone();
            let message = Closure::wrap(Box::new(move |event: MessageEvent| {
                let result = event.data().dyn_into::<js_sys::ArrayBuffer>();
                if let Ok(buffer) = result
                    && buffer.byte_length() as usize <= MAX_MESSAGE
                {
                    let mut inbox = shared.lock().unwrap();
                    inbox.receive(&js_sys::Uint8Array::new(&buffer).to_vec());
                    if matches!(inbox.session.state, State::Failed(_)) {
                        let _ = peer.close();
                    }
                    drop(inbox);
                    context.request_repaint();
                } else {
                    fail(
                        &shared,
                        &context,
                        "Demo frame is oversized or is not binary",
                    );
                    let _ = peer.close();
                }
            }) as Box<dyn FnMut(MessageEvent)>);
            let shared = inbox.clone();
            let context = ctx.clone();
            let error = Closure::wrap(Box::new(move |_: Event| {
                fail(
                    &shared,
                    &context,
                    "Local demo server is unavailable or the browser blocked the connection",
                )
            }) as Box<dyn FnMut(Event)>);
            let shared = inbox.clone();
            let close = Closure::wrap(Box::new(move |_: Event| {
                if !matches!(shared.lock().unwrap().session.state, State::Failed(_)) {
                    fail(&shared, &ctx, "Demo server disconnected");
                }
            }) as Box<dyn FnMut(Event)>);
            socket.set_onopen(Some(open.as_ref().unchecked_ref()));
            socket.set_onmessage(Some(message.as_ref().unchecked_ref()));
            socket.set_onerror(Some(error.as_ref().unchecked_ref()));
            socket.set_onclose(Some(close.as_ref().unchecked_ref()));
            Ok(Self {
                socket,
                inbox,
                _open: open,
                _message: message,
                _error: error,
                _close: close,
            })
        }
        pub fn send(&self, input: Input) -> Result<(), String> {
            if self.socket.ready_state() != WebSocket::OPEN
                || self.socket.buffered_amount() > 256 * 1024
            {
                return Err("Input queue is full or disconnected".into());
            }
            self.socket
                .send_with_u8_array(
                    &Message::Input(input)
                        .encode()
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|_| "Could not send input".into())
        }
        pub fn snapshot(&self) -> Snapshot {
            self.inbox.lock().unwrap().snapshot()
        }
    }
    impl Drop for Connection {
        fn drop(&mut self) {
            self.socket.set_onopen(None);
            self.socket.set_onmessage(None);
            self.socket.set_onerror(None);
            self.socket.set_onclose(None);
            let _ = self.socket.close();
        }
    }
}

pub use platform::Connection;

#[cfg(test)]
mod tests {
    use super::*;
    use crabfleet_client_core::CAPABILITIES;
    #[test]
    fn demo_endpoints_cannot_target_vendor_services() {
        assert!(endpoint(DEFAULT_ENDPOINT).is_ok());
        assert!(endpoint("ws://[::1]:9001/demo").is_ok());
        for value in [
            "wss://app.jumpdesktop.com/demo",
            "ws://example.org/demo",
            "ws://localhost:9001/other",
            "ws://user:password@localhost/demo",
            "ws://127.0.0.1/demo?secret=x",
        ] {
            assert!(endpoint(value).is_err(), "{value}");
        }
    }
    #[test]
    fn mailbox_keeps_only_latest_frame_and_enforces_message_order() {
        let mut inbox = Inbox::new();
        let frame = |n| {
            Message::Frame(Frame {
                width: 1,
                height: 1,
                sequence: n,
                input_count: 0,
                rgba: vec![0; 4],
            })
            .encode()
            .unwrap()
        };
        inbox.receive(&frame(1));
        assert!(matches!(inbox.snapshot().state, State::Failed(_)));
        let mut inbox = Inbox::new();
        inbox.receive(&Message::Hello(CAPABILITIES).encode().unwrap());
        for n in 0..10 {
            inbox.receive(&frame(n));
        }
        let snapshot = inbox.snapshot();
        assert_eq!(snapshot.frame.unwrap().sequence, 9);
        assert_eq!(snapshot.superseded, 9);
        assert!(inbox.snapshot().frame.is_none());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_transport_streams_input_and_reconnects_with_a_fresh_session() {
        use std::{
            net::TcpListener,
            sync::mpsc,
            thread,
            time::{Duration, Instant},
        };

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("ws://{}/demo", listener.local_addr().unwrap());
        let (finished, completion) = mpsc::channel();
        thread::spawn(move || {
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                let result =
                    crabfleet_demo_server::serve(stream).map_err(|error| error.to_string());
                finished.send(result).unwrap();
            }
        });
        for _ in 0..2 {
            let connection = Connection::open(&address, egui::Context::default()).unwrap();
            let wait_for_frame = |minimum_ack| {
                let deadline = Instant::now() + Duration::from_secs(4);
                loop {
                    let snapshot = connection.snapshot();
                    assert!(
                        !matches!(snapshot.state, State::Failed(_)),
                        "{:?}",
                        snapshot.state
                    );
                    if let Some(frame) = snapshot.frame
                        && frame.input_count >= minimum_ack
                    {
                        assert_eq!(snapshot.state, State::Live);
                        break frame;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "No frame acknowledging {minimum_ack} inputs"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            };
            let initial = wait_for_frame(0);
            assert_eq!(initial.input_count, 0);
            assert_eq!([initial.width, initial.height], [800, 450]);
            connection
                .send(Input::Pointer {
                    x: 400,
                    y: 200,
                    buttons: 1,
                })
                .unwrap();
            connection
                .send(Input::Key {
                    code: 13,
                    down: true,
                })
                .unwrap();
            let held = wait_for_frame(2);
            let pointer_pixel = (200 * 800 + 400) * 4;
            let key_pixel = (410 * 800 + 30) * 4;
            assert_eq!(
                &held.rgba[pointer_pixel..pointer_pixel + 4],
                &[250, 151, 86, 255]
            );
            assert_eq!(&held.rgba[key_pixel..key_pixel + 4], &[94, 225, 184, 255]);
            connection.send(Input::ReleaseAll).unwrap();
            let released = wait_for_frame(3);
            assert_eq!(
                &released.rgba[pointer_pixel..pointer_pixel + 4],
                &[248, 250, 244, 255]
            );
            assert_eq!(&released.rgba[key_pixel..key_pixel + 4], &[49, 69, 77, 255]);
            drop(connection);
            completion
                .recv_timeout(Duration::from_secs(3))
                .expect("Transport did not close promptly")
                .unwrap();
        }
    }
}
