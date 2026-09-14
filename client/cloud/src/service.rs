//! Authenticated signaling state; socket adapters feed bounded binary chunks.

use crate::{
    Error,
    auth::{Secret, validate_token},
    connection_id,
};
use crabfleet_fluid::{control::Empty, discovery::Directory, framing, signaling};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Connecting,
    Ready,
    Closed,
}
#[derive(Debug)]
pub enum Event {
    Ready,
    DirectoryChanged,
    Signal(signaling::PeerMessage),
}

pub struct Service {
    tokens: Vec<Secret>,
    state: State,
    directory: Directory,
    ice: signaling::IceServers,
    decoder: framing::Decoder,
    bound: Option<(String, String)>,
    first_signal: bool,
    started_ms: u64,
    last_ping_ms: u64,
    last_received_ms: u64,
    retryable: bool,
}
impl Service {
    pub fn new(token: Secret, now_ms: u64) -> Result<Self, Error> {
        validate_token(token.expose())?;
        Ok(Self {
            tokens: vec![token],
            state: State::Connecting,
            directory: Directory::default(),
            ice: signaling::IceServers::default(),
            decoder: framing::Decoder::default(),
            bound: None,
            first_signal: true,
            started_ms: now_ms,
            last_ping_ms: now_ms,
            last_received_ms: now_ms,
            retryable: false,
        })
    }
    pub fn state(&self) -> State {
        self.state
    }
    pub fn retryable_failure(&self) -> bool {
        self.state == State::Closed && self.retryable
    }
    pub fn directory(&self) -> &Directory {
        &self.directory
    }
    pub fn ice_servers(&self) -> &signaling::IceServers {
        &self.ice
    }

    pub fn opened(&self) -> Result<Vec<u8>, Error> {
        if self.state != State::Connecting {
            return Err(Error("Signaling is not connecting"));
        }
        framing::encode(&signaling::ClientMessage {
            connect: Some(signaling::Connect {
                version: Some("web".into()),
                tokens: self
                    .tokens
                    .iter()
                    .map(|token| token.expose().to_owned())
                    .collect(),
                allow_direct_sends_from_everyone: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        })
        .map_err(|_| Error("Could not encode signaling authentication"))
    }

    pub fn bind_computer(&mut self, id: &str) -> Result<&str, Error> {
        if self.state != State::Ready
            || !self
                .directory
                .get(id)
                .is_some_and(|computer| computer.can_connect())
        {
            return Err(Error(
                "Choose an online computer with supported Fluid transport",
            ));
        }
        self.bound = Some((id.to_owned(), connection_id()?));
        self.first_signal = true;
        Ok(&self.bound.as_ref().expect("Just assigned").1)
    }
    pub fn unbind(&mut self) {
        self.bound = None;
    }
    pub fn signal(&mut self, message: signaling::PeerMessage) -> Result<Vec<u8>, Error> {
        if self.state != State::Ready {
            return Err(Error("Signaling is disconnected"));
        }
        let (peer, connection) = self
            .bound
            .as_ref()
            .ok_or(Error("No computer is selected"))?;
        let message = signaling::signal(peer, connection, &message, None, self.first_signal)
            .map_err(|_| Error("Invalid peer signaling message"))?;
        let bytes = framing::encode(&message)
            .map_err(|_| Error("Signaling message exceeds the client limit"))?;
        self.first_signal = false;
        Ok(bytes)
    }

    pub fn receive(&mut self, bytes: &[u8], now_ms: u64) -> Result<Vec<Event>, Error> {
        let result = self.receive_inner(bytes, now_ms);
        if result.is_err() {
            self.disconnect();
        }
        result
    }
    fn receive_inner(&mut self, bytes: &[u8], now_ms: u64) -> Result<Vec<Event>, Error> {
        if self.state == State::Closed {
            return Err(Error("Signaling is closed"));
        }
        self.decoder
            .push(bytes)
            .map_err(|_| Error("Invalid signaling framing"))?;
        let mut events = Vec::new();
        let mut changed = false;
        for _ in 0..1024 {
            let Some(message) = self
                .decoder
                .next_message::<signaling::ServerMessage>()
                .map_err(|_| Error("Invalid signaling message"))?
            else {
                if changed {
                    events.push(Event::DirectoryChanged);
                }
                return Ok(events);
            };
            self.last_received_ms = now_ms;
            if let Some(close) = message.close {
                return Err(if close.reason == Some(2) {
                    Error("Account signaling authentication was rejected")
                } else {
                    Error("Signaling service closed the session")
                });
            }
            if let Some(connected) = message.connected {
                if let Some(ice) = connected.ice_servers {
                    self.update_ice(ice)?;
                }
                self.state = State::Ready;
                events.push(Event::Ready);
            }
            if let Some(ice) = message.ice_servers {
                self.update_ice(ice)?;
            }
            if let Some(tokens) = message.tokens
                && !tokens.tokens.is_empty()
            {
                if tokens.tokens.len() > 16 {
                    return Err(Error("Too many account tokens"));
                }
                for token in &tokens.tokens {
                    validate_token(token)?;
                }
                self.tokens = tokens.tokens.into_iter().map(Secret::new).collect();
            }
            if message.all_offline.is_some() {
                self.directory.all_offline();
                changed = true;
            }
            if let Some(presence) = message.presence {
                if self.state != State::Ready {
                    return Err(Error(
                        "Computer presence arrived before account authentication",
                    ));
                }
                self.directory
                    .presence(presence)
                    .map_err(|_| Error("Invalid computer advertisement"))?;
                changed = true;
            }
            if let Some(incoming) = message.incoming
                && let Some((peer, connection)) = &self.bound
                && let Some(message) = signaling::route(incoming, peer, connection)
                    .map_err(|_| Error("Invalid signal for the selected computer"))?
            {
                events.push(Event::Signal(message));
            }
        }
        if self.decoder.buffered_bytes() == 0 {
            if changed {
                events.push(Event::DirectoryChanged);
            }
            Ok(events)
        } else {
            Err(Error("Too many signaling messages in one update"))
        }
    }

    fn update_ice(&mut self, ice: signaling::IceServers) -> Result<(), Error> {
        if ice.servers.len() > 32 {
            return Err(Error("Too many ICE servers"));
        }
        for server in &ice.servers {
            if !server
                .uri
                .as_ref()
                .is_some_and(|uri| !uri.is_empty() && uri.len() <= 4096)
                || server
                    .username
                    .as_ref()
                    .is_some_and(|value| value.len() > 4096)
                || server
                    .password
                    .as_ref()
                    .is_some_and(|value| value.len() > 4096)
            {
                return Err(Error("Invalid ICE server"));
            }
        }
        self.ice = ice;
        Ok(())
    }

    pub fn tick(&mut self, now_ms: u64) -> Result<Option<Vec<u8>>, Error> {
        if self.state == State::Closed {
            return Ok(None);
        }
        if self.state == State::Connecting && now_ms.saturating_sub(self.started_ms) > 20_000
            || now_ms.saturating_sub(self.last_received_ms) > 150_000
        {
            self.disconnect();
            self.retryable = true;
            return Err(Error("Signaling service timed out"));
        }
        if now_ms.saturating_sub(self.last_ping_ms) >= 60_000 {
            self.last_ping_ms = now_ms;
            return framing::encode(&signaling::ClientMessage {
                ping: Some(Empty {}),
                ..Default::default()
            })
            .map(Some)
            .map_err(|_| Error("Could not encode signaling ping"));
        }
        Ok(None)
    }
    pub fn disconnect(&mut self) {
        self.retryable = false;
        self.state = State::Closed;
        self.directory.clear();
        self.bound = None;
        self.ice = signaling::IceServers::default();
        self.decoder = framing::Decoder::default();
    }
    pub fn reconnect(&mut self, now_ms: u64) -> Result<(), Error> {
        if self.tokens.is_empty() {
            return Err(Error("Sign in before reconnecting"));
        }
        self.disconnect();
        self.state = State::Connecting;
        self.started_ms = now_ms;
        self.last_ping_ms = now_ms;
        self.last_received_ms = now_ms;
        Ok(())
    }
    pub fn close(&mut self) {
        self.disconnect();
        self.tokens.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crabfleet_fluid::discovery::{Announcement, ServerInfo, ServerList};

    pub(super) fn advertise(service: &mut Service) {
        service
            .receive(
                &framing::encode(&signaling::ServerMessage {
                    connected: Some(signaling::Connected::default()),
                    ..Default::default()
                })
                .unwrap(),
                1,
            )
            .unwrap();
        let announcement = Announcement {
            server_list: Some(ServerList {
                servers: vec![ServerInfo {
                    name: Some("Synthetic desktop".into()),
                    protocol: Some(3),
                    ..Default::default()
                }],
                connect_methods: vec![2],
            }),
        };
        service
            .receive(
                &framing::encode(&signaling::ServerMessage {
                    presence: Some(signaling::Presence {
                        id: Some("local-peer".into()),
                        online: Some(true),
                        info: Some(framing::encode(&announcement).unwrap()),
                    }),
                    ..Default::default()
                })
                .unwrap(),
                2,
            )
            .unwrap();
    }

    #[test]
    fn selection_and_signals_are_bound_to_current_advertised_host() {
        let mut service = Service::new(Secret::new("synthetic-token".into()), 0).unwrap();
        assert!(service.bind_computer("unknown-peer").is_err());
        advertise(&mut service);
        assert!(service.bind_computer("unknown-peer").is_err());
        let first = service.bind_computer("local-peer").unwrap().to_owned();
        let peer_message = signaling::PeerMessage {
            close: Some(signaling::PeerClose::default()),
            ..Default::default()
        };
        let client = signaling::signal("local-peer", &first, &peer_message, None, false).unwrap();
        let response = signaling::ServerMessage {
            incoming: Some(signaling::Incoming {
                from_id: Some("local-peer".into()),
                data: client.send.unwrap().data,
                peer_unauthorized_to_send: Some(false),
            }),
            ..Default::default()
        };
        let bytes = framing::encode(&response).unwrap();
        assert!(matches!(
            service.receive(&bytes, 3).unwrap().as_slice(),
            [Event::Signal(_)]
        ));
        let second = service.bind_computer("local-peer").unwrap().to_owned();
        assert_ne!(first, second);
        assert!(service.receive(&bytes, 4).unwrap().is_empty());
        service.disconnect();
        assert_eq!(service.directory().computers().count(), 0);
        assert!(service.signal(peer_message).is_err());
    }

    #[test]
    fn refreshed_tokens_survive_reconnect_but_signout_clears_them() {
        let mut service = Service::new(Secret::new("old-synthetic".into()), 0).unwrap();
        advertise(&mut service);
        service
            .receive(
                &framing::encode(&signaling::ServerMessage {
                    tokens: Some(signaling::Tokens {
                        tokens: vec!["new-synthetic".into()],
                    }),
                    ..Default::default()
                })
                .unwrap(),
                10,
            )
            .unwrap();
        service.reconnect(20).unwrap();
        assert_eq!(service.directory().computers().count(), 0);
        let mut decoder = framing::Decoder::default();
        decoder.push(&service.opened().unwrap()).unwrap();
        let message = decoder
            .next_message::<signaling::ClientMessage>()
            .unwrap()
            .unwrap();
        assert_eq!(message.connect.unwrap().tokens, ["new-synthetic"]);
        service.close();
        assert!(service.reconnect(30).is_err());
    }

    #[test]
    fn malformed_presence_and_auth_rejection_end_session() {
        let mut service = Service::new(Secret::new("synthetic".into()), 0).unwrap();
        advertise(&mut service);
        assert!(service.receive(&[0xff; 5], 3).is_err());
        assert_eq!(service.state(), State::Closed);
        assert!(!service.retryable_failure());
        assert_eq!(service.directory().computers().count(), 0);
        service.reconnect(4).unwrap();
        let closed = signaling::ServerMessage {
            close: Some(signaling::Close {
                reason: Some(2),
                message: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            service
                .receive(&framing::encode(&closed).unwrap(), 5)
                .unwrap_err(),
            Error("Account signaling authentication was rejected")
        );
    }

    #[test]
    fn signaling_timeout_is_retryable_and_reconnect_requires_fresh_presence() {
        let mut service = Service::new(Secret::new("synthetic-token".into()), 0).unwrap();
        advertise(&mut service);
        assert!(service.tick(150_003).is_err());
        assert!(service.retryable_failure());
        assert!(service.directory().get("local-peer").is_none());
        service.reconnect(150_004).unwrap();
        assert!(!service.retryable_failure());
        assert!(service.bind_computer("local-peer").is_err());
    }
}
