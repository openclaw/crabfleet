use crate::{
    Error,
    auth::{AuthTask, Credentials, Outcome, Secret},
    service::{self, Service},
    socket::{self, Socket},
};
use crabfleet_fluid::{discovery::Directory, signaling};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    SignedOut,
    SigningIn,
    PasscodeRequired,
    PasscodeInvalid,
    CaptchaRequired,
    Connecting,
    Ready,
    Failed(Error),
}
pub struct Account {
    state: State,
    email: String,
    auth: Option<AuthTask>,
    pending: Option<Credentials>,
    auth_started_ms: u64,
    service: Option<Service>,
    socket: Option<Socket>,
    retryable: bool,
}
impl Default for Account {
    fn default() -> Self {
        Self {
            state: State::SignedOut,
            email: String::new(),
            auth: None,
            pending: None,
            auth_started_ms: 0,
            service: None,
            socket: None,
            retryable: false,
        }
    }
}
impl Account {
    pub fn state(&self) -> State {
        self.state
    }
    pub fn email(&self) -> &str {
        &self.email
    }
    pub fn can_reconnect(&self) -> bool {
        self.service.is_some() && matches!(self.state, State::Ready | State::Failed(_))
    }
    pub fn retryable_failure(&self) -> bool {
        self.can_reconnect() && matches!(self.state, State::Failed(_)) && self.retryable
    }
    pub fn directory(&self) -> Option<&Directory> {
        self.service.as_ref().map(Service::directory)
    }
    pub fn ice_servers(&self) -> Option<&signaling::IceServers> {
        self.service.as_ref().map(Service::ice_servers)
    }

    pub fn sign_in(&mut self, credentials: Credentials, now_ms: u64) -> Result<(), Error> {
        self.sign_out();
        let task = AuthTask::start(credentials.clone(), now_ms)?;
        self.pending = Some(credentials);
        self.auth = Some(task);
        self.auth_started_ms = now_ms;
        self.state = State::SigningIn;
        Ok(())
    }
    pub fn submit_passcode(
        &mut self,
        code: Secret,
        recovery: bool,
        now_ms: u64,
    ) -> Result<(), Error> {
        if !matches!(self.state, State::PasscodeRequired | State::PasscodeInvalid) {
            return Err(Error("Account is not waiting for a verification code"));
        }
        if now_ms.saturating_sub(self.auth_started_ms) > 120_000 {
            self.sign_out();
            return Err(Error("Sign-in expired; enter your password again"));
        }
        let credentials = self.pending.as_mut().ok_or(Error("Sign in again"))?;
        if recovery {
            credentials.recovery_code = Some(code);
            credentials.passcode = None;
        } else {
            credentials.passcode = Some(code);
            credentials.recovery_code = None;
        }
        self.auth = Some(AuthTask::start(credentials.clone(), now_ms)?);
        self.state = State::SigningIn;
        Ok(())
    }
    pub fn bind_computer(&mut self, id: &str) -> Result<String, Error> {
        self.service
            .as_mut()
            .ok_or(Error("Sign in first"))?
            .bind_computer(id)
            .map(str::to_owned)
    }
    pub fn unbind(&mut self) {
        if let Some(service) = &mut self.service {
            service.unbind();
        }
    }
    /// Queue signaling; socket failures surface through `poll` after earlier messages.
    pub fn send_signal(&mut self, message: signaling::PeerMessage) -> Result<(), Error> {
        let bytes = self
            .service
            .as_mut()
            .ok_or(Error("Sign in first"))?
            .signal(message)?;
        self.socket
            .as_mut()
            .ok_or(Error("Signaling is disconnected"))?
            .send(bytes);
        Ok(())
    }
    pub fn reconnect(&mut self, now_ms: u64) -> Result<(), Error> {
        self.socket = None;
        self.service
            .as_mut()
            .ok_or(Error("Sign in before reconnecting"))?
            .reconnect(now_ms)?;
        let socket = match Socket::connect() {
            Ok(socket) => socket,
            Err(error) => {
                self.fail(error, false);
                return Err(error);
            }
        };
        self.socket = Some(socket);
        self.retryable = false;
        self.state = State::Connecting;
        Ok(())
    }
    pub fn cancel_reconnect(&mut self) {
        if self.state == State::Connecting {
            self.fail(Error("Account connection canceled"), false);
        }
    }
    pub fn sign_out(&mut self) {
        if let Some(auth) = &mut self.auth {
            auth.cancel();
        }
        self.auth = None;
        self.pending = None;
        self.socket = None;
        if let Some(service) = &mut self.service {
            service.close();
        }
        self.service = None;
        self.email.clear();
        self.state = State::SignedOut;
        self.retryable = false;
    }
    pub fn poll(&mut self, now_ms: u64) -> Vec<service::Event> {
        if self.pending.is_some() && now_ms.saturating_sub(self.auth_started_ms) > 120_000 {
            self.fail(Error("Sign-in expired; enter your password again"), false);
        }
        if let Some(outcome) = self.auth.as_mut().and_then(|task| task.poll(now_ms)) {
            self.auth = None;
            match outcome {
                Ok(Outcome::SignedIn(signed_in)) => {
                    self.pending = None;
                    self.email = signed_in.email;
                    let result = Service::new(signed_in.token, now_ms)
                        .map_err(Failure::fatal)
                        .and_then(|service| {
                            self.service = Some(service);
                            self.socket = Some(Socket::connect().map_err(Failure::fatal)?);
                            Ok(())
                        });
                    match result {
                        Ok(()) => self.state = State::Connecting,
                        Err(failure) => self.fail(failure.error, failure.retryable),
                    }
                }
                Ok(Outcome::PasscodeRequired) => self.state = State::PasscodeRequired,
                Ok(Outcome::PasscodeInvalid) => self.state = State::PasscodeInvalid,
                Ok(Outcome::CaptchaRequired) => {
                    self.pending = None;
                    self.state = State::CaptchaRequired;
                }
                Ok(Outcome::Rejected) => self.fail(Error("Account sign-in was rejected"), false),
                Err(error) => self.fail(error, false),
            }
        }
        let mut events = Vec::new();
        let result = self.poll_service(now_ms, &mut events);
        if let Err(failure) = result {
            self.fail(failure.error, failure.retryable);
            // A selected host's termination must cancel recovery even when the
            // signaling transport fails later in the same batch.
            events.retain(
                |event| matches!(event, service::Event::Signal(message) if message.close.is_some()),
            );
        }
        events
    }
    fn poll_service(
        &mut self,
        now_ms: u64,
        events: &mut Vec<service::Event>,
    ) -> Result<(), Failure> {
        let (Some(socket), Some(service)) = (&mut self.socket, &mut self.service) else {
            return Ok(());
        };
        for event in socket.poll() {
            match event {
                socket::Event::Opened => socket.send(service.opened().map_err(Failure::fatal)?),
                socket::Event::Binary(bytes) => {
                    events.extend(service.receive(&bytes, now_ms).map_err(Failure::fatal)?);
                    if service.state() == service::State::Ready {
                        self.state = State::Ready;
                    }
                }
                socket::Event::Failed(error) => return Err(Failure::fatal(error)),
                socket::Event::Disconnected(error) => return Err(Failure::transport(error)),
            }
        }
        if let Some(bytes) = service.tick(now_ms).map_err(|error| Failure {
            error,
            retryable: service.retryable_failure(),
        })? {
            socket.send(bytes);
        }
        Ok(())
    }
    fn fail(&mut self, error: Error, retryable: bool) {
        if let Some(auth) = &mut self.auth {
            auth.cancel();
        }
        self.auth = None;
        self.pending = None;
        self.socket = None;
        if let Some(service) = &mut self.service {
            service.disconnect();
        }
        self.state = State::Failed(error);
        self.retryable = retryable;
    }
}
struct Failure {
    error: Error,
    retryable: bool,
}
impl Failure {
    fn fatal(error: Error) -> Self {
        Self {
            error,
            retryable: false,
        }
    }
    fn transport(error: Error) -> Self {
        Self {
            error,
            retryable: true,
        }
    }
}
impl Drop for Account {
    fn drop(&mut self) {
        self.sign_out();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crabfleet_fluid::{
        discovery::{Announcement, ServerInfo, ServerList},
        framing,
    };
    use std::{
        net::TcpListener,
        time::{Duration, Instant},
    };
    use tungstenite::Message;

    #[test]
    fn queued_disconnect_preserves_host_termination_and_failure_classification() {
        for send_before_poll in [false, true] {
            for kind in 0..4 {
                let mut service = Service::new(Secret::new("synthetic-token".into()), 0).unwrap();
                let announcement = Announcement {
                    server_list: Some(ServerList {
                        servers: vec![ServerInfo {
                            protocol: Some(3),
                            name: Some("Synthetic computer".into()),
                            ..Default::default()
                        }],
                        connect_methods: vec![2],
                    }),
                };
                service
                    .receive(
                        &framing::encode(&signaling::ServerMessage {
                            connected: Some(signaling::Connected::default()),
                            presence: Some(signaling::Presence {
                                id: Some("synthetic-peer".into()),
                                online: Some(true),
                                info: Some(framing::encode(&announcement).unwrap()),
                            }),
                            ..Default::default()
                        })
                        .unwrap(),
                        0,
                    )
                    .unwrap();
                let connection = service.bind_computer("synthetic-peer").unwrap().to_owned();
                let mut pending = Vec::new();
                if kind == 1 {
                    let termination = signaling::signal(
                        "synthetic-peer",
                        &connection,
                        &signaling::PeerMessage {
                            close: Some(signaling::PeerClose { reason: Some(1) }),
                            ..Default::default()
                        },
                        None,
                        false,
                    )
                    .unwrap();
                    pending.push(socket::Event::Binary(
                        framing::encode(&signaling::ServerMessage {
                            incoming: Some(signaling::Incoming {
                                from_id: Some("synthetic-peer".into()),
                                data: termination.send.unwrap().data,
                                ..Default::default()
                            }),
                            ..Default::default()
                        })
                        .unwrap(),
                    ));
                } else if kind == 2 {
                    pending.push(socket::Event::Binary(
                        framing::encode(&signaling::ServerMessage {
                            close: Some(signaling::Close {
                                reason: Some(2),
                                message: None,
                            }),
                            ..Default::default()
                        })
                        .unwrap(),
                    ));
                }
                pending.push(if kind == 3 {
                    socket::Event::Failed(Error("Synthetic policy failure"))
                } else {
                    socket::Event::Disconnected(Error("Synthetic transport failure"))
                });
                let mut account = Account {
                    state: State::Ready,
                    service: Some(service),
                    socket: Some(Socket::with_events_for_test(pending)),
                    email: String::new(),
                    auth: None,
                    pending: None,
                    auth_started_ms: 0,
                    retryable: false,
                };
                if send_before_poll {
                    account
                        .send_signal(signaling::PeerMessage {
                            candidate: Some(signaling::IceCandidate {
                                candidate: Some("synthetic candidate".into()),
                                ..Default::default()
                            }),
                            ..Default::default()
                        })
                        .unwrap();
                    assert_eq!(account.state(), State::Ready);
                }
                let events = account.poll(1);
                assert!(matches!(account.state(), State::Failed(_)));
                assert_eq!(account.retryable_failure(), kind < 2);
                if kind == 1 {
                    assert!(
                        matches!(events.as_slice(), [service::Event::Signal(message)] if message.close.is_some())
                    );
                } else {
                    assert!(events.is_empty());
                }
                if kind == 2 {
                    assert_eq!(
                        account.state(),
                        State::Failed(Error("Account signaling authentication was rejected"))
                    );
                }
                assert!(account.poll(2).is_empty());
            }
        }
    }

    #[test]
    fn disconnect_during_initial_send_keeps_its_transport_classification() {
        let socket = Socket::with_events_for_test(vec![
            socket::Event::Opened,
            socket::Event::Disconnected(Error("Synthetic transport failure")),
        ]);
        let mut account = Account {
            state: State::Connecting,
            service: Some(Service::new(Secret::new("synthetic-token".into()), 0).unwrap()),
            socket: Some(socket),
            email: String::new(),
            auth: None,
            pending: None,
            auth_started_ms: 0,
            retryable: false,
        };
        assert!(account.poll(1).is_empty());
        assert!(account.retryable_failure());
    }

    #[test]
    fn abrupt_network_loss_is_retryable_but_a_preceding_auth_rejection_is_not() {
        for reject in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut socket = tungstenite::accept(stream).unwrap();
                assert!(matches!(socket.read().unwrap(), Message::Binary(_)));
                let message = if reject {
                    signaling::ServerMessage {
                        close: Some(signaling::Close {
                            reason: Some(2),
                            message: None,
                        }),
                        ..Default::default()
                    }
                } else {
                    signaling::ServerMessage {
                        connected: Some(signaling::Connected::default()),
                        ..Default::default()
                    }
                };
                socket
                    .send(Message::Binary(framing::encode(&message).unwrap().into()))
                    .unwrap();
                socket.close(None).unwrap();
            });
            let mut account = Account {
                state: State::Connecting,
                email: String::new(),
                auth: None,
                pending: None,
                auth_started_ms: 0,
                service: Some(Service::new(Secret::new("synthetic-token".into()), 0).unwrap()),
                socket: Some(Socket::connect_for_test(address)),
                retryable: false,
            };
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(3)
                && !matches!(account.state(), State::Failed(_))
            {
                account.poll(start.elapsed().as_millis() as u64);
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(matches!(account.state(), State::Failed(_)));
            assert_eq!(account.retryable_failure(), !reject);
            if reject {
                assert_eq!(
                    account.state(),
                    State::Failed(Error("Account signaling authentication was rejected"))
                );
            }
            assert!(account.can_reconnect());
            account.sign_out();
            assert!(!account.can_reconnect());
            assert!(!account.retryable_failure());
            server.join().unwrap();
        }
    }
}
