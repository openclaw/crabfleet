//! Fluid session orchestration over the platform WebRTC adapter. Signaling must
//! already be scoped to the selected authorized host by the account layer.

use crate::{Candidate, Description, Error, Event, Options, Peer, Updates, VideoFrame};
use crabfleet_fluid::{
    control::{Clipboard, Control, InputEvent},
    framing, session,
};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    NetworkLost,
    Transport(Error),
    Wire(framing::WireError),
    Session(session::SessionError),
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NetworkLost => f.write_str("The connection to the remote computer was lost"),
            Self::Transport(e) => e.fmt(f),
            Self::Wire(e) => e.fmt(f),
            Self::Session(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for Failure {}
impl From<Error> for Failure {
    fn from(value: Error) -> Self {
        Self::Transport(value)
    }
}
impl From<framing::WireError> for Failure {
    fn from(value: framing::WireError) -> Self {
        Self::Wire(value)
    }
}
impl From<session::SessionError> for Failure {
    fn from(value: session::SessionError) -> Self {
        Self::Session(value)
    }
}

pub struct ConnectionUpdates {
    /// Only signaling, connection-state, and audio-playback events escape here.
    pub transport: Vec<Event>,
    pub session: Vec<session::Event>,
    /// Always absent before a host view grant or after its revocation.
    pub frame: Option<VideoFrame>,
    pub failure: Option<Failure>,
    /// Retained even when a later transport failure suppresses session events.
    pub view_revoked: bool,
}

pub struct Connection {
    peer: Peer,
    session: session::Session,
    decoder: framing::Decoder,
    started_ms: u64,
    interactive: bool,
    desired_audio: bool,
    opened: bool,
    ended: bool,
    failure: Option<Failure>,
    disconnected_ms: Option<u64>,
}

impl Connection {
    pub fn new(mut options: Options, interactive: bool, now_ms: u64) -> Result<Self, Failure> {
        let desired_audio = options.audio_enabled;
        options.audio_enabled = false;
        let mut peer = Peer::new(options)?;
        peer.start()?;
        Ok(Self {
            peer,
            session: session::Session::default(),
            decoder: framing::Decoder::default(),
            started_ms: now_ms,
            interactive,
            desired_audio,
            opened: false,
            ended: false,
            failure: None,
            disconnected_ms: None,
        })
    }

    pub fn state(&self) -> session::State {
        self.session.state()
    }
    pub fn permissions(&self) -> session::Permissions {
        self.session.permissions()
    }
    pub fn supports_text_input(&self) -> bool {
        self.session.supports_text_input()
    }

    pub fn set_remote_description(&mut self, description: Description) -> Result<(), Failure> {
        let result = self
            .peer
            .set_remote_description(description)
            .map_err(Failure::from);
        self.record(result)
    }
    pub fn add_candidate(&mut self, candidate: Candidate) -> Result<(), Failure> {
        let result = self.peer.add_candidate(candidate).map_err(Failure::from);
        self.record(result)
    }

    pub fn authenticate(&mut self, username: String, password: String) -> Result<(), Failure> {
        let message = self.session.authenticate(username, password)?;
        self.send(message)
    }
    pub fn input(&mut self, input: InputEvent) -> Result<(), Failure> {
        let message = self.session.input(input)?;
        self.send(message)
    }
    pub fn commit_text(&mut self, text: String) -> Result<(), Failure> {
        for message in self.session.commit_text(text)? {
            self.send(message)?;
        }
        Ok(())
    }
    pub fn shortcut(&mut self, shortcut: session::Shortcut) -> Result<(), Failure> {
        for message in self.session.shortcut(shortcut)? {
            self.send(message)?;
        }
        Ok(())
    }
    pub fn paste_text(&mut self, text: &[u8]) -> Result<(), Failure> {
        for message in self.session.paste_text(text)? {
            self.send(message)?;
        }
        Ok(())
    }
    pub fn clipboard(&mut self, clipboard: Clipboard) -> Result<(), Failure> {
        self.send(self.session.clipboard(clipboard)?)
    }
    pub fn select_display(&mut self, id: String) -> Result<(), Failure> {
        self.send(self.session.select_display(id)?)
    }
    pub fn set_clipboard_enabled(&mut self, enabled: bool) {
        self.session.set_clipboard_enabled(enabled);
    }
    pub fn set_view_only(&mut self, enabled: bool) -> Result<(), Failure> {
        for message in self.session.set_view_only(enabled) {
            self.send(message)?;
        }
        Ok(())
    }
    pub fn release_inputs(&mut self) -> Result<(), Failure> {
        for message in self.session.release_inputs() {
            self.send(message)?;
        }
        Ok(())
    }
    pub fn set_audio_enabled(&mut self, enabled: bool) -> Result<(), Failure> {
        self.desired_audio = enabled;
        let result = self
            .peer
            .set_audio_enabled(enabled && self.permissions().can_view())
            .map_err(Failure::from);
        self.record(result)
    }

    pub fn poll(&mut self, now_ms: u64) -> ConnectionUpdates {
        let mut output = ConnectionUpdates {
            transport: Vec::new(),
            session: Vec::new(),
            frame: None,
            failure: None,
            view_revoked: false,
        };
        if self.ended {
            output.failure = self.failure.take();
            return output;
        }
        let updates = self.peer.poll();
        if let Err(error) = self.consume(updates, now_ms, &mut output) {
            self.fail(error);
        }
        if !self.ended {
            let result = if self
                .disconnected_ms
                .is_some_and(|since| now_ms.saturating_sub(since) >= 5_000)
            {
                Err(Failure::NetworkLost)
            } else if !self.opened && now_ms.saturating_sub(self.started_ms) > 45_000 {
                Err(Failure::Transport(Error("WebRTC negotiation timed out")))
            } else {
                self.session
                    .tick(self.session.generation(), now_ms)
                    .map_err(Failure::from)
                    .and_then(|message| message.map_or(Ok(()), |message| self.send(message)))
            };
            if let Err(error) = result {
                self.fail(error);
            }
        }
        if self.ended {
            output.frame = None;
            output
                .session
                .retain(|event| matches!(event, session::Event::PeerEnded { .. }));
            output.transport.clear();
        }
        output.failure = self.failure.take();
        output
    }

    fn consume(
        &mut self,
        updates: Updates,
        now_ms: u64,
        output: &mut ConnectionUpdates,
    ) -> Result<(), Failure> {
        let mut messages = 0;
        for event in updates.events {
            match event {
                Event::ControlOpened => {
                    if self.opened {
                        return Err(Error("Control channel opened twice").into());
                    }
                    self.opened = true;
                    // Request audio once; local playback stays muted until authorized.
                    let message = self.session.open(now_ms, self.interactive, true);
                    self.send(message)?;
                }
                Event::ControlData(bytes) => {
                    if !self.opened {
                        return Err(Error("Control data arrived before channel open").into());
                    }
                    self.decoder.push(&bytes)?;
                    loop {
                        if messages >= 1024 && self.decoder.buffered_bytes() > 0 {
                            return Err(Error("Too many Fluid messages in one update").into());
                        }
                        let Some(message) = self.decoder.next_message::<Control>()? else {
                            break;
                        };
                        messages += 1;
                        let update =
                            self.session
                                .receive(self.session.generation(), message, now_ms)?;
                        // Record revocation before fallible input-release sends
                        // can tear down the session and suppress its events.
                        output.view_revoked |= update.events.iter().any(|event| {
                            matches!(event, session::Event::Permissions(permissions) if !permissions.can_view())
                        });
                        for message in update.outbound {
                            self.send(message)?;
                        }
                        for event in update.events {
                            if let session::Event::Permissions(permissions) = event {
                                self.peer.set_audio_enabled(
                                    self.desired_audio && permissions.can_view(),
                                )?;
                            }
                            output.session.push(event);
                        }
                        if self.session.state() == session::State::Ended {
                            self.close();
                            return Ok(());
                        }
                    }
                }
                Event::ControlClosed => {
                    self.decoder.finish()?;
                    return Err(Error("Remote control channel closed").into());
                }
                Event::NetworkLost => return Err(Failure::NetworkLost),
                Event::Connection(crate::ConnectionState::Disconnected) => {
                    self.disconnected_ms.get_or_insert(now_ms);
                }
                Event::Connection(crate::ConnectionState::Connected) => {
                    self.disconnected_ms = None;
                    output
                        .transport
                        .push(Event::Connection(crate::ConnectionState::Connected));
                }
                Event::Failed(error) => return Err(error.into()),
                event => output.transport.push(event),
            }
        }
        if self.permissions().can_view() && !output.view_revoked {
            output.frame = updates.frame;
        }
        Ok(())
    }

    fn send(&mut self, message: Control) -> Result<(), Failure> {
        let result = framing::encode(&message)
            .map_err(Failure::from)
            .and_then(|bytes| self.peer.send_control(&bytes).map_err(Failure::from));
        self.record(result)
    }

    fn record(&mut self, result: Result<(), Failure>) -> Result<(), Failure> {
        if let Err(error) = result {
            self.fail(error);
        }
        result
    }
    fn fail(&mut self, error: Failure) {
        if self.ended {
            return;
        }
        self.close();
        self.failure = Some(error);
    }
    pub fn close(&mut self) {
        if self.ended {
            return;
        }
        self.ended = true;
        // Best effort releases are queued before transport shutdown. Abrupt network
        // loss still requires the host to release input when the session ends.
        for message in self.session.release_inputs() {
            if let Ok(bytes) = framing::encode(&message) {
                let _ = self.peer.send_control(&bytes);
            }
        }
        self.session.close();
        self.decoder = framing::Decoder::default();
        self.peer.close();
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crabfleet_fluid::control::{HostAuth, KeyInput, PeerInfo};

    #[test]
    fn view_revocation_survives_a_failed_input_release() {
        let mut connection = Connection::new(Options::default(), true, 0).unwrap();
        connection.session.open(0, true, false);
        for message in [
            Control {
                peer_info: Some(PeerInfo {
                    supports_interactive_auth: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Control {
                auth: Some(HostAuth {
                    access_mask_updated: Some(7),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ] {
            connection
                .session
                .receive(connection.session.generation(), message, 1)
                .unwrap();
        }
        connection
            .session
            .input(InputEvent {
                key: Some(KeyInput {
                    usb_keycode: Some(0x70004),
                    pressed: Some(true),
                }),
                ..Default::default()
            })
            .unwrap();
        connection.opened = true;
        // Revocation has arrived, but its automatic key release can no longer send.
        connection.peer.close();
        let updates = Updates {
            events: vec![
                Event::ControlData(
                    framing::encode(&Control {
                        auth: Some(HostAuth {
                            access_mask_updated: Some(0),
                            ..Default::default()
                        }),
                        ..Default::default()
                    })
                    .unwrap(),
                ),
                Event::NetworkLost,
            ],
            frame: Some(VideoFrame {
                width: 1,
                height: 1,
                rgba: vec![255; 4],
            }),
            audio_samples: 0,
        };
        let mut output = ConnectionUpdates {
            transport: Vec::new(),
            session: Vec::new(),
            frame: None,
            failure: None,
            view_revoked: false,
        };
        assert!(connection.consume(updates, 2, &mut output).is_err());
        assert!(output.view_revoked);
        assert!(output.frame.is_none());
        assert!(!connection.permissions().can_view());
        assert!(connection.poll(3).failure.is_some());
        assert!(connection.poll(4).failure.is_none());
    }
}
