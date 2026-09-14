//! Owns account and host lifetimes together; the UI never handles service tokens.
use crate::jump_reconnect::{Recovery, Status as RecoveryStatus, Step as RecoveryStep};
use crabfleet_cloud::{
    account,
    auth::{Credentials, Secret},
    service,
};
use crabfleet_fluid::{control::*, discovery::Computer, session, signaling};
use crabfleet_rtc::{self as rtc, connection::Connection};
use std::sync::Arc;
use zeroize::Zeroizing;

pub const MAX_COMMAND_BYTES: usize = 4 * 1024 * 1024;
const UTF8: i32 = 1;

pub enum Action {
    SignIn(Credentials),
    SignOut,
    Reconnect,
    Connect { id: String, interactive: bool },
    Disconnect,
    Passcode { code: Secret, recovery: bool },
    HostCredentials { username: String, password: Secret },
    Input(InputEvent),
    CommitText(Zeroizing<String>),
    Shortcut(session::Shortcut),
    Paste(Zeroizing<String>),
    Release,
    ViewOnly(bool),
    Audio(bool),
    ClipboardEnabled(bool),
    SendClipboard(Zeroizing<String>),
    GetClipboard,
    Display(String),
}
impl Action {
    pub fn resets_session(&self) -> bool {
        matches!(
            self,
            Self::SignIn(_)
                | Self::SignOut
                | Self::Reconnect
                | Self::Connect { .. }
                | Self::Disconnect
        )
    }
    pub fn bytes(&self) -> usize {
        128 + match self {
            Self::SignIn(c) => {
                c.email.len()
                    + c.password.expose().len()
                    + c.passcode.as_ref().map_or(0, |s| s.expose().len())
                    + c.recovery_code.as_ref().map_or(0, |s| s.expose().len())
                    + c.captcha.as_ref().map_or(0, |s| s.expose().len())
            }
            Self::Passcode { code, .. } => code.expose().len(),
            Self::HostCredentials { username, password } => {
                username.len() + password.expose().len()
            }
            Self::Input(i) => i
                .text
                .as_ref()
                .and_then(|t| t.text.as_ref())
                .map_or(0, String::len),
            Self::SendClipboard(text) | Self::CommitText(text) | Self::Paste(text) => text.len(),
            Self::Connect { id, .. } | Self::Display(id) => id.len(),
            _ => 0,
        }
    }
    fn targets_host(&self) -> bool {
        matches!(
            self,
            Self::HostCredentials { .. }
                | Self::Input(_)
                | Self::CommitText(_)
                | Self::Shortcut(_)
                | Self::Paste(_)
                | Self::Release
                | Self::SendClipboard(_)
                | Self::GetClipboard
                | Self::Display(_)
        )
    }
}
pub struct Command {
    pub epoch: u64,
    pub media_revision: u64,
    pub action: Action,
}

#[derive(Clone, PartialEq)]
pub struct Snapshot {
    pub epoch: u64,
    pub account: account::State,
    pub email: String,
    pub can_reconnect: bool,
    pub computers: Arc<Vec<Computer>>,
    pub computer: Option<String>,
    pub session: session::State,
    pub permissions: session::Permissions,
    pub supports_text_input: bool,
    pub media_revision: u64,
    pub waiting_for_approval: bool,
    pub interactive_auth: bool,
    pub displays: DisplayConfig,
    pub cursor: crabfleet_fluid::cursor::State,
    pub view_only: bool,
    pub audio: bool,
    pub audio_blocked: bool,
    pub clipboard_enabled: bool,
    pub clipboard_revision: u64,
    pub clipboard: Arc<Zeroizing<String>>,
    pub error: Option<String>,
    pub recovery: Option<RecoveryStatus>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            epoch: 0,
            account: account::State::SignedOut,
            email: String::new(),
            can_reconnect: false,
            computers: Arc::default(),
            computer: None,
            session: session::State::Disconnected,
            permissions: Default::default(),
            supports_text_input: false,
            media_revision: 0,
            waiting_for_approval: false,
            interactive_auth: true,
            displays: Default::default(),
            cursor: Default::default(),
            view_only: false,
            audio: false,
            audio_blocked: false,
            clipboard_enabled: false,
            clipboard_revision: 0,
            clipboard: Arc::new(Zeroizing::new(String::new())),
            error: None,
            recovery: None,
        }
    }
}
#[derive(Default)]
pub struct Runtime {
    account: account::Account,
    connection: Option<Connection>,
    pub snapshot: Snapshot,
    local_clipboard: Option<Zeroizing<String>>,
    clipboard_requested: bool,
    recovery: Recovery,
}
impl Runtime {
    pub fn command(&mut self, command: Command, now_ms: u64) {
        if command.action.resets_session() {
            if command.epoch <= self.snapshot.epoch {
                return;
            }
            if self.recovery.active() && matches!(command.action, Action::Disconnect) {
                self.account.cancel_reconnect();
            }
            self.recovery.cancel();
            self.close_host();
            self.snapshot.epoch = command.epoch;
            self.snapshot.error = None;
        } else if command.epoch != self.snapshot.epoch {
            return;
        }
        if command.action.targets_host() && command.media_revision != self.snapshot.media_revision {
            return;
        }
        if let Err(error) = self.apply(command.action, now_ms) {
            self.snapshot.error = Some(error);
        }
        self.refresh(now_ms);
    }
    fn apply(&mut self, action: Action, now_ms: u64) -> Result<(), String> {
        match action {
            Action::SignIn(c) => {
                self.recovery.enable();
                self.account.sign_in(c, now_ms).map_err(|e| e.to_string())?;
            }
            Action::SignOut => {
                self.account.sign_out();
                self.snapshot.error = None;
            }
            Action::Reconnect => {
                self.recovery.enable();
                self.account.reconnect(now_ms).map_err(|e| e.to_string())?;
            }
            Action::Passcode { code, recovery } => self
                .account
                .submit_passcode(code, recovery, now_ms)
                .map_err(|e| e.to_string())?,
            Action::Connect { id, interactive } => {
                self.snapshot.interactive_auth = interactive;
                self.connect_host(&id, now_ms)?;
                self.recovery.select(id);
            }
            Action::Disconnect => {}
            Action::ViewOnly(enabled) => {
                self.snapshot.view_only = enabled;
                if let Some(c) = &mut self.connection {
                    c.set_view_only(enabled).map_err(|e| e.to_string())?;
                }
            }
            Action::Audio(enabled) => {
                self.snapshot.audio = enabled;
                self.snapshot.audio_blocked = false;
                if let Some(c) = &mut self.connection {
                    c.set_audio_enabled(enabled).map_err(|e| e.to_string())?;
                }
            }
            Action::ClipboardEnabled(enabled) => {
                self.snapshot.clipboard_enabled = enabled;
                if !enabled {
                    self.clear_clipboard();
                }
                if let Some(c) = &mut self.connection {
                    c.set_clipboard_enabled(enabled);
                }
            }
            Action::Release => {
                if let Some(c) = &mut self.connection {
                    c.release_inputs().map_err(|e| e.to_string())?;
                }
            }
            Action::HostCredentials { username, password } => self
                .host()?
                .authenticate(username, password.expose().to_owned())
                .map_err(|e| e.to_string())?,
            Action::Input(input) => self.host()?.input(input).map_err(|e| e.to_string())?,
            Action::CommitText(text) => self
                .host()?
                .commit_text(text.to_string())
                .map_err(|e| e.to_string())?,
            Action::Shortcut(shortcut) => {
                self.host()?.shortcut(shortcut).map_err(|e| e.to_string())?
            }
            Action::Paste(text) => {
                self.host()?
                    .paste_text(text.as_bytes())
                    .map_err(|e| e.to_string())?;
                self.local_clipboard = Some(text);
            }
            Action::Display(id) => {
                if !self
                    .snapshot
                    .displays
                    .displays
                    .iter()
                    .any(|d| d.id.as_deref() == Some(&id))
                {
                    return Err("This display is no longer available".into());
                }
                self.host()?.release_inputs().map_err(|e| e.to_string())?;
                self.host()?.select_display(id).map_err(|e| e.to_string())?;
            }
            Action::SendClipboard(text) => {
                if text.len() > 1024 * 1024 {
                    return Err("Clipboard text exceeds 1 MiB".into());
                }
                self.host()?
                    .clipboard(Clipboard {
                        available: Some(ClipboardAvailable { types: vec![UTF8] }),
                        ..Default::default()
                    })
                    .map_err(|e| e.to_string())?;
                self.local_clipboard = Some(text);
            }
            Action::GetClipboard => {
                self.host()?
                    .clipboard(Clipboard {
                        request: Some(ClipboardRequest {
                            content_type: Some(UTF8),
                        }),
                        ..Default::default()
                    })
                    .map_err(|e| e.to_string())?;
                self.clipboard_requested = true;
            }
        }
        Ok(())
    }
    fn host(&mut self) -> Result<&mut Connection, String> {
        self.connection
            .as_mut()
            .ok_or_else(|| "Connect to a computer first".into())
    }

    fn connect_host(&mut self, id: &str, now_ms: u64) -> Result<(), String> {
        self.account.bind_computer(id).map_err(|e| e.to_string())?;
        let options = rtc::Options {
            audio_enabled: self.snapshot.audio,
            ice_servers: self
                .account
                .ice_servers()
                .into_iter()
                .flat_map(|servers| servers.servers.iter())
                .filter_map(|server| {
                    Some(rtc::IceServer {
                        uri: server.uri.clone()?,
                        username: server.username.clone(),
                        password: server.password.clone(),
                    })
                })
                .collect(),
        };
        let result = Connection::new(options, self.snapshot.interactive_auth, now_ms).and_then(
            |mut connection| {
                connection.set_view_only(self.snapshot.view_only)?;
                connection.set_clipboard_enabled(self.snapshot.clipboard_enabled);
                Ok(connection)
            },
        );
        match result {
            Ok(connection) => {
                self.connection = Some(connection);
                self.snapshot.computer = Some(id.to_owned());
                self.snapshot.session = session::State::Negotiating;
                Ok(())
            }
            Err(error) => {
                self.account.unbind();
                Err(error.to_string())
            }
        }
    }

    fn advance_recovery(&mut self, now_ms: u64) {
        let was_active = self.recovery.active();
        let online = self.recovery.target().is_some_and(|id| {
            self.account
                .directory()
                .and_then(|d| d.get(id))
                .is_some_and(Computer::can_connect)
        });
        let viewing = self
            .connection
            .as_ref()
            .is_some_and(|c| c.permissions().can_view());
        match self.recovery.poll(
            now_ms,
            self.account.state(),
            self.account.retryable_failure(),
            online,
            viewing,
        ) {
            Some(RecoveryStep::Account) => {
                if let Err(error) = self.account.reconnect(now_ms) {
                    self.snapshot.error = Some(error.to_string());
                }
            }
            Some(RecoveryStep::Host(id)) => {
                if let Err(error) = self.connect_host(&id, now_ms) {
                    self.fail_host(error);
                } else {
                    self.snapshot.error = None;
                }
            }
            Some(RecoveryStep::Exhausted) => {
                self.account.cancel_reconnect();
                self.close_host();
                self.snapshot.error = Some("Automatic reconnection stopped after five attempts or two minutes. Reconnect manually to try again.".into());
            }
            None if was_active
                && !self.recovery.active()
                && self.account.state() == account::State::Ready =>
            {
                self.snapshot.error = None;
            }
            None => {}
        }
    }

    pub fn poll(&mut self, now_ms: u64) -> Option<rtc::VideoFrame> {
        let events = self.account.poll(now_ms);
        if self.account.state() != account::State::Ready && self.connection.is_some() {
            self.close_host();
        }
        for event in events {
            match event {
                service::Event::DirectoryChanged | service::Event::Ready => {
                    self.refresh_directory()
                }
                service::Event::Signal(message) => {
                    if let Err(error) = self.incoming(message) {
                        self.fail_host(error);
                    }
                }
            }
        }
        let Some(c) = &mut self.connection else {
            self.advance_recovery(now_ms);
            self.refresh(now_ms);
            return None;
        };
        let updates = c.poll(now_ms);
        if updates.view_revoked {
            self.recovery.cancel_host();
        }
        if let Some(error) = updates.failure {
            if matches!(
                error,
                rtc::connection::Failure::NetworkLost
                    | rtc::connection::Failure::Session(session::SessionError::Timeout)
            ) && self.recovery.host_lost(now_ms)
            {
                self.close_host();
                self.snapshot.error = Some(error.to_string());
            } else {
                self.fail_host(error.to_string());
            }
            self.advance_recovery(now_ms);
            self.refresh(now_ms);
            return None;
        }
        for event in updates.transport {
            if let Some(message) = outbound(event, &mut self.snapshot.audio_blocked)
                && let Err(error) = self.account.send_signal(message)
            {
                if self.account.retryable_failure() {
                    self.close_host();
                    self.snapshot.error = Some(error.to_string());
                } else {
                    self.fail_host(error.to_string());
                }
                self.advance_recovery(now_ms);
                self.refresh(now_ms);
                return None;
            }
        }
        let mut view_revoked = false;
        for event in updates.session {
            match event {
                session::Event::WaitingForHostApproval => self.snapshot.waiting_for_approval = true,
                session::Event::NeedHostCredentials => self.snapshot.waiting_for_approval = false,
                session::Event::Permissions(p) => {
                    self.snapshot.waiting_for_approval = false;
                    if !p.can_view() {
                        self.recovery.cancel_host();
                        view_revoked = true;
                        self.snapshot.displays = Default::default();
                        self.snapshot.cursor = Default::default();
                        self.snapshot.media_revision = self.snapshot.media_revision.wrapping_add(1);
                    } else {
                        self.recovery.confirm_host();
                    }
                    if !p.can_clipboard() {
                        self.clear_clipboard();
                    }
                }
                session::Event::Displays(displays) => self.snapshot.displays = displays,
                session::Event::Cursor(cursor) => {
                    if self.connection.is_some() {
                        self.snapshot.cursor = cursor;
                    }
                }
                session::Event::Clipboard(clipboard) => {
                    if let Err(error) = self.receive_clipboard(clipboard) {
                        self.fail_host(error);
                    }
                }
                session::Event::PeerEnded {
                    code,
                    interactive_failure,
                } => self.fail_host(peer_termination_message(code, interactive_failure)),
            }
        }
        self.advance_recovery(now_ms);
        self.refresh(now_ms);
        if !view_revoked && self.snapshot.permissions.can_view() {
            updates.frame
        } else {
            None
        }
    }
    fn incoming(&mut self, message: signaling::PeerMessage) -> Result<(), String> {
        if message.close.is_some() {
            self.close_host();
            return Err("The remote computer closed the connection".into());
        }
        let Some(c) = &mut self.connection else {
            return Ok(());
        };
        if let Some(sdp) = message.sdp {
            let kind = match sdp.sdp_type.as_deref() {
                Some("offer") => rtc::SdpKind::Offer,
                Some("answer") => rtc::SdpKind::Answer,
                _ => return Err("Invalid remote session description".into()),
            };
            c.set_remote_description(rtc::Description {
                kind,
                sdp: sdp.sdp.ok_or("Missing session description")?,
            })
            .map_err(|e| e.to_string())?;
        }
        if let Some(candidate) = message.candidate {
            let index = u32::try_from(candidate.sdp_m_line_index.unwrap_or(0))
                .map_err(|_| "Invalid ICE media index")?;
            c.add_candidate(rtc::Candidate {
                candidate: candidate.candidate.unwrap_or_default(),
                mid: candidate.sdp_mid,
                mline_index: index,
            })
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn receive_clipboard(&mut self, clipboard: Clipboard) -> Result<(), String> {
        if clipboard
            .request
            .is_some_and(|r| r.content_type == Some(UTF8))
            && let Some(text) = &self.local_clipboard
        {
            let content = ClipboardContent {
                content_type: Some(UTF8),
                content: Some(text.as_bytes().to_vec()),
            };
            self.host()?
                .clipboard(Clipboard {
                    content: Some(content),
                    ..Default::default()
                })
                .map_err(|e| e.to_string())?;
        }
        if let Some(content) = clipboard.content
            && content.content_type == Some(UTF8)
            && self.clipboard_requested
        {
            self.clipboard_requested = false;
            let text = String::from_utf8(content.content.unwrap_or_default())
                .map_err(|_| "Remote clipboard is not valid UTF-8")?;
            self.snapshot.clipboard = Arc::new(Zeroizing::new(text));
            self.snapshot.clipboard_revision = self.snapshot.clipboard_revision.wrapping_add(1);
        }
        Ok(())
    }
    fn refresh_directory(&mut self) {
        self.snapshot.computers = Arc::new(
            self.account
                .directory()
                .map(|d| d.computers().cloned().collect())
                .unwrap_or_default(),
        );
    }
    fn refresh(&mut self, now_ms: u64) {
        if self.snapshot.account != self.account.state() {
            self.refresh_directory();
        }
        self.snapshot.account = self.account.state();
        self.snapshot.can_reconnect = self.account.can_reconnect();
        self.snapshot.recovery = self.recovery.status(now_ms, self.account.state());
        if self.snapshot.email != self.account.email() {
            self.snapshot.email = self.account.email().to_owned();
        }
        if let Some(c) = &self.connection {
            self.snapshot.session = if c.state() == session::State::Disconnected {
                session::State::Negotiating
            } else {
                c.state()
            };
            self.snapshot.permissions = c.permissions();
            self.snapshot.supports_text_input = c.supports_text_input();
        }
    }
    fn clear_clipboard(&mut self) {
        self.local_clipboard = None;
        self.clipboard_requested = false;
        self.snapshot.clipboard = Arc::new(Zeroizing::new(String::new()));
        self.snapshot.clipboard_revision = self.snapshot.clipboard_revision.wrapping_add(1);
    }
    fn close_host(&mut self) {
        if let Some(mut c) = self.connection.take() {
            c.close();
        }
        self.account.unbind();
        self.snapshot.computer = None;
        self.snapshot.session = session::State::Disconnected;
        self.snapshot.permissions = Default::default();
        self.snapshot.supports_text_input = false;
        self.snapshot.media_revision = self.snapshot.media_revision.wrapping_add(1);
        self.snapshot.displays = Default::default();
        self.snapshot.cursor = Default::default();
        self.snapshot.waiting_for_approval = false;
        self.snapshot.audio_blocked = false;
        self.clear_clipboard();
    }
    fn fail_host(&mut self, error: String) {
        self.recovery.cancel_host();
        self.close_host();
        self.snapshot.error = Some(error);
    }
}
fn peer_termination_message(code: i32, interactive_failure: Option<i32>) -> String {
    let message = match code {
        1 => "The host rejected the local username or password",
        2 => "The host timed out waiting for the connection",
        3 => "The host rejected the connection after too many sign-in attempts",
        4 => "The host rejected the authentication token",
        5 | 13 => "Another user is connected to this computer",
        6 => match interactive_failure {
            Some(2) => "The connection request was rejected on the host",
            Some(3) => "Host approval timed out",
            Some(4) => "No user is available on the host to approve the connection",
            Some(5) => "The host rejected the approval code",
            Some(6) => "This host cannot provide interactive approval",
            Some(7) => "The host could not identify the requesting client",
            _ => "Interactive host authentication failed",
        },
        11 => "Screen Recording permission is unavailable on the host",
        12 => "The remote user signed out",
        14 => "The host ended the idle session",
        15 => "The host has reached its concurrent connection limit",
        18 => "The host reached its maximum session duration",
        _ => "The remote computer ended the session",
    };
    if code == 6
        && let Some(reason) = interactive_failure
    {
        format!("{message} (code {code}, reason {reason})")
    } else {
        format!("{message} (code {code})")
    }
}

fn outbound(event: rtc::Event, audio_blocked: &mut bool) -> Option<signaling::PeerMessage> {
    Some(match event {
        rtc::Event::Description(d) => signaling::PeerMessage {
            sdp: Some(signaling::SessionDescription {
                sdp_type: Some(
                    match d.kind {
                        rtc::SdpKind::Offer => "offer",
                        rtc::SdpKind::Answer => "answer",
                    }
                    .into(),
                ),
                sdp: Some(d.sdp),
                unified_plan: Some(true),
            }),
            ..Default::default()
        },
        rtc::Event::Candidate(c) => signaling::PeerMessage {
            candidate: Some(signaling::IceCandidate {
                candidate: Some(c.candidate),
                sdp_mid: c.mid,
                sdp_m_line_index: Some(c.mline_index as i32),
            }),
            ..Default::default()
        },
        rtc::Event::AudioPlaybackBlocked => {
            *audio_blocked = true;
            return None;
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_connection_fences_old_input_and_cancel_clears_recovery_intent() {
        let mut runtime = Runtime::default();
        runtime.recovery.select("synthetic computer".into());
        runtime.recovery.confirm_host();
        runtime.recovery.host_lost(0);
        let previous_revision = runtime.snapshot.media_revision;
        runtime.close_host();
        runtime.command(
            Command {
                epoch: 0,
                media_revision: previous_revision,
                action: Action::Paste(Zeroizing::new("old text".into())),
            },
            1,
        );
        assert!(runtime.snapshot.error.is_none());
        assert!(runtime.local_clipboard.is_none());
        runtime.command(
            Command {
                epoch: 0,
                media_revision: runtime.snapshot.media_revision,
                action: Action::GetClipboard,
            },
            2,
        );
        assert_eq!(
            runtime.snapshot.error.as_deref(),
            Some("Connect to a computer first")
        );
        runtime.command(
            Command {
                epoch: 1,
                media_revision: previous_revision,
                action: Action::Disconnect,
            },
            3,
        );
        assert!(!runtime.recovery.active());
        assert!(runtime.recovery.target().is_none());
        assert!(runtime.snapshot.recovery.is_none());
    }
    #[test]
    fn stale_commands_cannot_change_new_session_preferences_or_sign_out() {
        let mut runtime = Runtime::default();
        runtime.command(
            Command {
                epoch: 1,
                media_revision: 0,
                action: Action::Disconnect,
            },
            0,
        );
        runtime.command(
            Command {
                epoch: 1,
                media_revision: 0,
                action: Action::ViewOnly(true),
            },
            1,
        );
        runtime.command(
            Command {
                epoch: 2,
                media_revision: 0,
                action: Action::Disconnect,
            },
            2,
        );
        runtime.command(
            Command {
                epoch: 1,
                media_revision: 0,
                action: Action::ViewOnly(false),
            },
            3,
        );
        runtime.command(
            Command {
                epoch: 1,
                media_revision: 0,
                action: Action::SignOut,
            },
            4,
        );
        assert_eq!(runtime.snapshot.epoch, 2);
        assert!(runtime.snapshot.view_only);
        assert!(runtime.snapshot.computer.is_none());
    }
    #[test]
    fn clipboard_requires_a_request_and_is_erased_on_disconnect() {
        let mut runtime = Runtime::default();
        let content = || Clipboard {
            content: Some(ClipboardContent {
                content_type: Some(UTF8),
                content: Some(b"synthetic clipboard".to_vec()),
            }),
            ..Default::default()
        };
        runtime.receive_clipboard(content()).unwrap();
        assert!(runtime.snapshot.clipboard.is_empty());
        runtime.clipboard_requested = true;
        runtime.receive_clipboard(content()).unwrap();
        assert_eq!(runtime.snapshot.clipboard.as_str(), "synthetic clipboard");
        assert!(!runtime.clipboard_requested);
        runtime.command(
            Command {
                epoch: 1,
                media_revision: 0,
                action: Action::Disconnect,
            },
            0,
        );
        assert!(runtime.snapshot.clipboard.is_empty());
        assert!(runtime.local_clipboard.is_none());
    }
    #[test]
    fn invalid_selection_clears_old_host_state_and_never_starts_a_peer() {
        let mut runtime = Runtime::default();
        runtime.snapshot.computer = Some("old synthetic selection".into());
        runtime.snapshot.waiting_for_approval = true;
        runtime.command(
            Command {
                epoch: 1,
                media_revision: 0,
                action: Action::Connect {
                    id: "unannounced-id".into(),
                    interactive: true,
                },
            },
            0,
        );
        assert!(runtime.connection.is_none());
        assert!(runtime.snapshot.computer.is_none());
        assert!(runtime.snapshot.error.is_some());
        assert!(!runtime.snapshot.waiting_for_approval);
        assert!(runtime.poll(1).is_none());
    }
    #[test]
    fn signaling_adapter_preserves_description_and_candidate_routing_fields() {
        let mut blocked = false;
        let offer = outbound(
            rtc::Event::Description(rtc::Description {
                kind: rtc::SdpKind::Offer,
                sdp: "synthetic SDP".into(),
            }),
            &mut blocked,
        )
        .unwrap()
        .sdp
        .unwrap();
        assert_eq!(offer.sdp_type.as_deref(), Some("offer"));
        assert_eq!(offer.unified_plan, Some(true));
        let candidate = outbound(
            rtc::Event::Candidate(rtc::Candidate {
                candidate: "synthetic candidate".into(),
                mline_index: 2,
                mid: Some("video".into()),
            }),
            &mut blocked,
        )
        .unwrap()
        .candidate
        .unwrap();
        assert_eq!(candidate.sdp_m_line_index, Some(2));
        assert_eq!(candidate.sdp_mid.as_deref(), Some("video"));
        assert!(outbound(rtc::Event::AudioPlaybackBlocked, &mut blocked).is_none());
        assert!(blocked);
    }
}
