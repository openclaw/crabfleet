use super::*;
use std::{
    io::ErrorKind,
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{SyncSender, TrySendError, sync_channel},
    },
    time::{Duration, Instant},
};
use tungstenite::{
    HandshakeError, Message, error::ProtocolError, handshake::HandshakeRole,
    protocol::WebSocketConfig, stream::MaybeTlsStream,
};

static ACTIVE_SOCKETS: AtomicUsize = AtomicUsize::new(0);
struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE_SOCKETS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct Socket {
    inbox: Shared,
    outgoing: SyncSender<Vec<u8>>,
    alive: Arc<AtomicBool>,
}
impl Socket {
    pub fn connect() -> Result<Self, Error> {
        Self::connect_to(crate::SIGNAL_URL.to_owned())
    }
    #[cfg(test)]
    pub(crate) fn connect_for_test(address: std::net::SocketAddr) -> Self {
        assert!(address.ip().is_loopback());
        Self::connect_to(format!("ws://{address}/test")).expect("Loopback test socket")
    }
    fn connect_to(url: String) -> Result<Self, Error> {
        ACTIVE_SOCKETS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 4).then_some(count + 1)
            })
            .map_err(|_| Error("Previous signaling connections are still closing"))?;
        let slot = Slot;
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        let alive = Arc::new(AtomicBool::new(true));
        let (outgoing, receiver) = sync_channel(128);
        let shared = inbox.clone();
        let running = alive.clone();
        std::thread::Builder::new()
            .name("crabfleet-cloud-signaling".into())
            .spawn(move || {
                let _slot = slot;
                let result = run(&url, &shared, &running, receiver);
                if let Err(failure) = result {
                    let mut inbox = shared.lock().unwrap();
                    match failure {
                        Failure::Fatal(error) => inbox.fail(error),
                        Failure::Transport(error) => inbox.disconnected(error),
                    }
                }
            })
            .map_err(|_| Error("Could not start signaling worker"))?;
        Ok(Self {
            inbox,
            outgoing,
            alive,
        })
    }
    /// Queue a message; `poll` reports failures without replacing a pending close reason.
    pub fn send(&mut self, bytes: Vec<u8>) {
        let mut inbox = self.inbox.lock().unwrap();
        if inbox.ended {
            return;
        }
        if bytes.len() > MAX_MESSAGE {
            inbox.fail(Error("Signaling message exceeds its limit"));
            return;
        }
        if bytes.len() > MAX_QUEUED.saturating_sub(inbox.outgoing_bytes) {
            inbox.fail(Error("Signaling write queue exceeded its limit"));
            return;
        }
        inbox.outgoing_bytes += bytes.len();
        match self.outgoing.try_send(bytes) {
            Ok(()) => {}
            Err(TrySendError::Full(bytes)) => {
                inbox.outgoing_bytes -= bytes.len();
                inbox.fail(Error("Signaling write queue exceeded its limit"));
            }
            Err(TrySendError::Disconnected(bytes)) => {
                inbox.outgoing_bytes -= bytes.len();
                // The worker publishes its terminal reason after releasing the
                // receiver; do not replace that reason or earlier protocol data.
            }
        }
    }
    pub fn poll(&mut self) -> Vec<Event> {
        let mut inbox = self.inbox.lock().unwrap();
        if inbox.ended {
            self.alive.store(false, Ordering::Release);
        }
        inbox.drain()
    }
    pub fn close(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.inbox.lock().unwrap().close();
    }
    #[cfg(test)]
    pub(crate) fn with_events_for_test(events: Vec<Event>) -> Self {
        let mut inbox = Inbox::default();
        for event in events {
            match event {
                Event::Disconnected(error) => inbox.disconnected(error),
                Event::Failed(error) => inbox.fail(error),
                event => inbox.push(event),
            }
        }
        Self {
            inbox: Arc::new(Mutex::new(inbox)),
            outgoing: sync_channel(1).0,
            alive: Arc::new(AtomicBool::new(false)),
        }
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        self.close();
    }
}

fn pending(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(error) if error.kind() == ErrorKind::WouldBlock)
}
enum Failure {
    Fatal(Error),
    Transport(Error),
}
impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Fatal(error)
    }
}
fn socket_failure(error: tungstenite::Error, message: &'static str) -> Failure {
    let retryable = match error {
        // Rustls reports certificate/record failures as InvalidData I/O errors.
        tungstenite::Error::Io(error) => matches!(
            error.kind(),
            ErrorKind::ConnectionReset
                | ErrorKind::ConnectionAborted
                | ErrorKind::ConnectionRefused
                | ErrorKind::NotConnected
                | ErrorKind::BrokenPipe
                | ErrorKind::TimedOut
                | ErrorKind::UnexpectedEof
                | ErrorKind::WouldBlock
                | ErrorKind::Interrupted
                | ErrorKind::NetworkDown
                | ErrorKind::NetworkUnreachable
                | ErrorKind::HostUnreachable
        ),
        tungstenite::Error::ConnectionClosed
        | tungstenite::Error::AlreadyClosed
        | tungstenite::Error::Protocol(ProtocolError::ResetWithoutClosingHandshake) => true,
        _ => false,
    };
    if retryable {
        Failure::Transport(Error(message))
    } else {
        Failure::Fatal(Error(message))
    }
}
fn handshake_failure<Role: HandshakeRole>(error: HandshakeError<Role>) -> Failure {
    const MESSAGE: &str = "Signaling TLS or WebSocket handshake failed";
    match error {
        // On this blocking socket, WouldBlock means its I/O deadline expired.
        HandshakeError::Interrupted(_)
        | HandshakeError::Failure(tungstenite::Error::Protocol(
            ProtocolError::HandshakeIncomplete,
        )) => Failure::Transport(Error(MESSAGE)),
        HandshakeError::Failure(error) => socket_failure(error, MESSAGE),
    }
}
fn tcp(stream: &MaybeTlsStream<TcpStream>) -> Result<&TcpStream, Error> {
    match stream {
        MaybeTlsStream::Plain(stream) => Ok(stream),
        MaybeTlsStream::Rustls(stream) => Ok(&stream.sock),
        _ => Err(Error("Unexpected signaling TLS transport")),
    }
}
fn run(
    url: &str,
    inbox: &Shared,
    alive: &AtomicBool,
    receiver: std::sync::mpsc::Receiver<Vec<u8>>,
) -> Result<(), Failure> {
    // The only production endpoint is fixed. The test-only caller supplies loopback.
    let uri: tungstenite::http::Uri = url
        .parse()
        .map_err(|_| Error("Invalid signaling endpoint"))?;
    let host = uri.host().ok_or(Error("Invalid signaling endpoint"))?;
    let port = uri.port_u16().unwrap_or(443);
    let deadline = Instant::now() + Duration::from_secs(20);
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| Failure::Transport(Error("Could not resolve signaling service")))?;
    let mut stream = None;
    for address in addresses.take(8) {
        if !alive.load(Ordering::Acquire) {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(candidate) =
            TcpStream::connect_timeout(&address, remaining.min(Duration::from_secs(5)))
        {
            stream = Some(candidate);
            break;
        }
    }
    let stream = stream.ok_or(Failure::Transport(Error(
        "Could not connect to signaling service",
    )))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|_| Error("Could not configure signaling socket"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(8)))
        .map_err(|_| Error("Could not configure signaling socket"))?;
    stream
        .set_nodelay(true)
        .map_err(|_| Error("Could not configure signaling socket"))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE))
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_QUEUED);
    let (mut socket, _) = tungstenite::client_tls_with_config(url, stream, Some(config), None)
        .map_err(handshake_failure)?;
    if !alive.load(Ordering::Acquire) {
        return Ok(());
    }
    tcp(socket.get_ref())?
        .set_nonblocking(true)
        .map_err(|_| Error("Could not configure signaling socket"))?;
    inbox.lock().unwrap().push(Event::Opened);
    let mut stalled_since = None;
    while alive.load(Ordering::Acquire) && !inbox.lock().unwrap().ended {
        for bytes in receiver.try_iter().take(32) {
            let mut shared = inbox.lock().unwrap();
            shared.outgoing_bytes = shared.outgoing_bytes.saturating_sub(bytes.len());
            drop(shared);
            if let Err(error) = socket.write(Message::Binary(bytes.into()))
                && !pending(&error)
            {
                return Err(socket_failure(error, "Signaling write failed"));
            }
        }
        match socket.flush() {
            Ok(()) => stalled_since = None,
            Err(error) if pending(&error) => {
                let start = stalled_since.get_or_insert_with(Instant::now);
                if start.elapsed() > Duration::from_secs(5) {
                    return Err(Failure::Transport(Error("Signaling write timed out")));
                }
            }
            Err(error) => return Err(socket_failure(error, "Signaling write failed")),
        }
        for _ in 0..32 {
            match socket.read() {
                Ok(Message::Binary(bytes)) => {
                    inbox.lock().unwrap().push(Event::Binary(bytes.to_vec()))
                }
                Ok(Message::Text(_)) => {
                    return Err(Error("Expected binary signaling messages").into());
                }
                Ok(Message::Close(frame)) => {
                    let error = Error("Signaling server disconnected");
                    return Err(if retryable_close(frame.map(|f| u16::from(f.code))) {
                        Failure::Transport(error)
                    } else {
                        Failure::Fatal(error)
                    });
                }
                Ok(_) => {}
                Err(error) if pending(&error) => break,
                Err(error) => return Err(socket_failure(error, "Signaling connection failed")),
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = socket.close(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::Secret,
        service::{Service, State},
    };
    use crabfleet_fluid::{
        discovery::{Announcement, ServerInfo, ServerList},
        framing, signaling,
    };

    #[test]
    fn handshake_network_failures_retry_but_tls_policy_and_protocol_errors_stop() {
        use std::io::{Cursor, Read, Write};
        #[derive(Debug)]
        struct Transport {
            response: Cursor<&'static [u8]>,
            error: Option<ErrorKind>,
        }
        impl Read for Transport {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                match self.error {
                    Some(kind) => Err(kind.into()),
                    None => self.response.read(bytes),
                }
            }
        }
        impl Write for Transport {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let cases: &[(Option<ErrorKind>, &'static [u8], bool)] = &[
            (Some(ErrorKind::ConnectionReset), b"", true),
            (Some(ErrorKind::TimedOut), b"", true),
            (Some(ErrorKind::WouldBlock), b"", true),
            (Some(ErrorKind::InvalidData), b"", false),
            (Some(ErrorKind::PermissionDenied), b"", false),
            (None, b"", true),
            (
                None,
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n",
                false,
            ),
            (None, b"invalid HTTP response\r\n\r\n", false),
        ];
        for &(error, response, retryable) in cases {
            let result = tungstenite::client(
                "ws://localhost/test",
                Transport {
                    response: Cursor::new(response),
                    error,
                },
            )
            .unwrap_err();
            assert_eq!(
                matches!(handshake_failure(result), Failure::Transport(_)),
                retryable
            );
        }
        let tls =
            HandshakeError::<tungstenite::handshake::client::ClientHandshake<Transport>>::Failure(
                tungstenite::Error::Tls(tungstenite::error::TlsError::InvalidDnsName),
            );
        assert!(matches!(handshake_failure(tls), Failure::Fatal(_)));

        let mut socket = tungstenite::WebSocket::from_raw_socket(
            Transport {
                response: Cursor::new(b""),
                error: None,
            },
            tungstenite::protocol::Role::Client,
            None,
        );
        assert!(matches!(
            socket_failure(socket.read().unwrap_err(), "Synthetic EOF"),
            Failure::Transport(_)
        ));
    }

    #[test]
    fn send_overflow_is_fatal_but_a_worker_exit_preserves_pending_events() {
        let (outgoing, receiver) = sync_channel(1);
        let mut socket = Socket {
            inbox: Arc::new(Mutex::new(Inbox::default())),
            outgoing,
            alive: Arc::new(AtomicBool::new(false)),
        };
        socket.send(vec![1]);
        socket.send(vec![2]);
        assert!(matches!(socket.poll().as_slice(), [Event::Failed(_)]));
        assert_eq!(receiver.try_recv().unwrap(), [1]);

        let mut socket = Socket::with_events_for_test(vec![Event::Binary(vec![3])]);
        // The receiver has gone away, but its worker has not yet published why.
        socket.send(vec![4]);
        socket
            .inbox
            .lock()
            .unwrap()
            .disconnected(Error("Synthetic disconnect"));
        assert!(
            matches!(socket.poll().as_slice(), [Event::Binary(bytes), Event::Disconnected(_)] if bytes == &[3])
        );
        assert_eq!(socket.inbox.lock().unwrap().outgoing_bytes, 0);

        let mut socket = Socket::with_events_for_test(Vec::new());
        socket.send(vec![0; MAX_MESSAGE + 1]);
        assert!(matches!(socket.poll().as_slice(), [Event::Failed(_)]));
    }

    #[test]
    fn socket_authentication_presence_selection_and_reconnect_on_loopback() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/test", listener.local_addr().unwrap());
        let (done, completion) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut socket = tungstenite::accept(stream).unwrap();
                let Message::Binary(bytes) = socket.read().unwrap() else {
                    panic!("Expected authentication");
                };
                let mut decoder = framing::Decoder::default();
                decoder.push(&bytes).unwrap();
                let auth = decoder
                    .next_message::<signaling::ClientMessage>()
                    .unwrap()
                    .unwrap();
                assert_eq!(auth.connect.unwrap().tokens, ["synthetic-token"]);
                let announce = Announcement {
                    server_list: Some(ServerList {
                        servers: vec![ServerInfo {
                            protocol: Some(3),
                            name: Some("Local test machine".into()),
                            ..Default::default()
                        }],
                        connect_methods: vec![2],
                    }),
                };
                let mut messages = framing::encode(&signaling::ServerMessage {
                    connected: Some(signaling::Connected::default()),
                    ..Default::default()
                })
                .unwrap();
                messages.extend(
                    framing::encode(&signaling::ServerMessage {
                        presence: Some(signaling::Presence {
                            id: Some("local-peer".into()),
                            online: Some(true),
                            info: Some(framing::encode(&announce).unwrap()),
                        }),
                        ..Default::default()
                    })
                    .unwrap(),
                );
                // A split length prefix/body must be reconstructed across WebSocket messages.
                socket
                    .send(Message::Binary(messages[..1].to_vec().into()))
                    .unwrap();
                socket
                    .send(Message::Binary(messages[1..].to_vec().into()))
                    .unwrap();
                assert!(matches!(socket.read().unwrap(), Message::Close(_)));
                done.send(()).unwrap();
            }
        });
        for _ in 0..2 {
            let mut service = Service::new(Secret::new("synthetic-token".into()), 0).unwrap();
            let mut socket = Socket::connect_to(url.clone()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                for event in socket.poll() {
                    match event {
                        Event::Opened => socket.send(service.opened().unwrap()),
                        Event::Binary(bytes) => {
                            service.receive(&bytes, 1).unwrap();
                        }
                        Event::Failed(error) | Event::Disconnected(error) => {
                            panic!("Loopback signaling failed: {error}")
                        }
                    }
                }
                if service.directory().get("local-peer").is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(service.state(), State::Ready);
            assert!(service.bind_computer("local-peer").is_ok());
            socket.close();
            socket.close();
            socket.send(vec![0]);
            assert!(socket.poll().is_empty());
            completion.recv_timeout(Duration::from_secs(3)).unwrap();
            service.close();
        }
    }
}
