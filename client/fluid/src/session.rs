use crate::control::*;
use std::{collections::BTreeSet, fmt};

const VIEW: u32 = 1;
const CONTROL: u32 = 2;
const CLIPBOARD: u32 = 4;
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    Copy,
    Cut,
    Paste,
    Escape,
    CapsLock,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Permissions(u32);
impl Permissions {
    pub fn can_view(self) -> bool {
        self.0 & VIEW != 0
    }
    pub fn can_control(self) -> bool {
        self.0 & CONTROL != 0 && self.can_view()
    }
    pub fn can_clipboard(self) -> bool {
        self.0 & CLIPBOARD != 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Disconnected,
    Negotiating,
    AwaitingCredentials,
    Authenticating,
    Authorized,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionError {
    WrongState,
    PermissionDenied,
    InvalidInput,
    InvalidPeerMessage,
    UnsupportedCompression,
    UnsupportedAuthentication,
    UnsupportedTextInput,
    Timeout,
}
impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Fluid session: {self:?}")
    }
}
impl std::error::Error for SessionError {}

#[derive(Debug, PartialEq)]
pub enum Event {
    NeedHostCredentials,
    WaitingForHostApproval,
    Permissions(Permissions),
    Displays(DisplayConfig),
    Clipboard(Clipboard),
    Cursor(crate::cursor::State),
    PeerEnded {
        code: i32,
        interactive_failure: Option<i32>,
    },
}

#[derive(Default, Debug)]
pub struct Update {
    pub outbound: Vec<Control>,
    pub events: Vec<Event>,
}

pub struct Session {
    state: State,
    generation: u64,
    permissions: Permissions,
    peer: Option<PeerInfo>,
    interactive: bool,
    view_only: bool,
    clipboard_enabled: bool,
    system_audio: bool,
    media_requested: bool,
    held_keys: BTreeSet<u32>,
    held_text: BTreeSet<String>,
    held_buttons: BTreeSet<i32>,
    pointer: MouseInput,
    cursor: crate::cursor::Tracker,
    last_ping_ms: u64,
    last_pong_ms: u64,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            state: State::Disconnected,
            generation: 0,
            permissions: Permissions::default(),
            peer: None,
            interactive: true,
            view_only: false,
            clipboard_enabled: false,
            system_audio: true,
            media_requested: false,
            held_keys: BTreeSet::new(),
            held_text: BTreeSet::new(),
            held_buttons: BTreeSet::new(),
            pointer: MouseInput::default(),
            cursor: Default::default(),
            last_ping_ms: 0,
            last_pong_ms: 0,
        }
    }
}

impl Session {
    pub fn state(&self) -> State {
        self.state
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn permissions(&self) -> Permissions {
        self.permissions
    }
    pub fn supports_text_input(&self) -> bool {
        self.peer
            .as_ref()
            .is_some_and(|p| p.supports_text_inject_up_down == Some(true))
    }

    /// A committed string is one operation, with no physical key duplicated.
    pub fn commit_text(&mut self, text: String) -> Result<Vec<Control>, SessionError> {
        self.require_control()?;
        if !self.supports_text_input() {
            return Err(SessionError::UnsupportedTextInput);
        }
        if text.len() > MAX_TEXT_BYTES || text.is_empty() {
            return Err(SessionError::InvalidInput);
        }
        let mut output = self.release_inputs();
        // Whole-string insertion happens on either edge. Windows switches at
        // two UTF-16 units; Mac switches at two Unicode characters.
        let whole_string = match self.peer.as_ref().and_then(|p| p.os_type) {
            Some(0) => text.encode_utf16().nth(1).is_some(),
            Some(1) => text.chars().nth(1).is_some(),
            _ => false,
        };
        let edges: &[bool] = if whole_string {
            &[false]
        } else {
            &[true, false]
        };
        for &down in edges {
            output.push(self.input(InputEvent {
                text: Some(TextInput {
                    text: Some(text.clone()),
                    down: Some(down),
                }),
                ..Default::default()
            })?);
        }
        Ok(output)
    }

    pub fn shortcut(&mut self, shortcut: Shortcut) -> Result<Vec<Control>, SessionError> {
        self.require_control()?;
        // Fluid PeerInfo uses Mac=1; discovery's OS enum instead uses Mac=2.
        let modifier = if self.peer.as_ref().and_then(|p| p.os_type) == Some(1) {
            0x700e3
        } else {
            0x700e0
        };
        let key = match shortcut {
            Shortcut::Copy => 0x70006,
            Shortcut::Cut => 0x7001b,
            Shortcut::Paste => 0x70019,
            Shortcut::Escape => 0x70029,
            Shortcut::CapsLock => 0x70039,
        };
        let mut output = self.release_inputs();
        let single_key = matches!(shortcut, Shortcut::Escape | Shortcut::CapsLock);
        for (code, pressed) in [
            (modifier, true),
            (key, true),
            (key, false),
            (modifier, false),
        ] {
            if single_key && code == modifier {
                continue;
            }
            output.push(self.input(InputEvent {
                key: Some(KeyInput {
                    usb_keycode: Some(code),
                    pressed: Some(pressed),
                }),
                ..Default::default()
            })?);
        }
        Ok(output)
    }

    /// Check both grants before changing either clipboard or held input.
    pub fn paste_text(&mut self, text: &[u8]) -> Result<Vec<Control>, SessionError> {
        self.require_control()?;
        if text.len() > MAX_CLIPBOARD_BYTES || std::str::from_utf8(text).is_err() {
            return Err(SessionError::InvalidInput);
        }
        let content = self.clipboard(Clipboard {
            content: Some(ClipboardContent {
                content_type: Some(1),
                content: Some(text.to_vec()),
            }),
            ..Default::default()
        })?;
        let available = self.clipboard(Clipboard {
            available: Some(ClipboardAvailable { types: vec![1] }),
            ..Default::default()
        })?;
        let mut output = vec![available, content];
        output.extend(self.shortcut(Shortcut::Paste)?);
        Ok(output)
    }

    fn require_control(&self) -> Result<(), SessionError> {
        if self.state != State::Authorized || !self.permissions.can_control() || self.view_only {
            Err(SessionError::PermissionDenied)
        } else {
            Ok(())
        }
    }

    /// Call only after a fresh, authenticated transport's RTC data channel opens.
    pub fn open(&mut self, now_ms: u64, interactive: bool, system_audio: bool) -> Control {
        self.close();
        self.state = State::Negotiating;
        self.interactive = interactive;
        self.system_audio = system_audio;
        self.last_ping_ms = now_ms;
        self.last_pong_ms = now_ms;
        Control {
            peer_info: Some(PeerInfo::default()),
            ..Default::default()
        }
    }

    pub fn close(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.state = State::Ended;
        self.permissions = Permissions::default();
        self.peer = None;
        self.media_requested = false;
        self.held_keys.clear();
        self.held_text.clear();
        self.held_buttons.clear();
        self.pointer = MouseInput::default();
        self.cursor = Default::default();
    }

    fn fail<T>(&mut self, error: SessionError) -> Result<T, SessionError> {
        self.close();
        Err(error)
    }

    pub fn receive(
        &mut self,
        generation: u64,
        message: Control,
        now_ms: u64,
    ) -> Result<Update, SessionError> {
        let mut update = Update::default();
        if generation != self.generation || matches!(self.state, State::Disconnected | State::Ended)
        {
            return Ok(update);
        }
        if let Some(error) = message.error {
            self.close();
            update.events.push(Event::PeerEnded {
                code: error.code.unwrap_or(0),
                interactive_failure: error.interactive_failure,
            });
            return Ok(update);
        }
        // This implementation advertises an empty compression list until ZSTD is supported.
        if message.compression_start.is_some() {
            return self.fail(SessionError::UnsupportedCompression);
        }
        if let Some(peer) = message.peer_info {
            if peer.supported_compression_types.len() > 32 {
                return self.fail(SessionError::InvalidPeerMessage);
            }
            let first = self.peer.is_none();
            if first {
                let supported = if self.interactive {
                    peer.supports_interactive_auth
                } else {
                    peer.supports_local_auth
                };
                if supported != Some(true) {
                    return self.fail(SessionError::UnsupportedAuthentication);
                }
            }
            self.peer = Some(peer);
            if first {
                if self.interactive {
                    self.state = State::Authenticating;
                    update.outbound.push(Control {
                        auth: Some(HostAuth {
                            interactive: Some(Empty {}),
                            ..Default::default()
                        }),
                        ..Default::default()
                    });
                    update.events.push(Event::WaitingForHostApproval);
                } else {
                    self.state = State::AwaitingCredentials;
                    update.events.push(Event::NeedHostCredentials);
                }
            }
        }
        if let Some(mask) = message.auth.and_then(|auth| auth.access_mask_updated) {
            if !matches!(self.state, State::Authenticating | State::Authorized) {
                return self.fail(SessionError::InvalidPeerMessage);
            }
            let previous = self.permissions;
            let current = Permissions(mask);
            if previous.can_control() && !current.can_control() {
                update.outbound.extend(self.release_inputs());
            }
            self.permissions = current;
            self.state = State::Authorized;
            update.events.push(Event::Permissions(current));
            if current.can_view() && !self.media_requested {
                self.media_requested = true;
                update.outbound.push(desktop(DesktopClient {
                    add_media: Some(AddDesktopMedia {
                        suspended: Some(false),
                        add_system_audio: Some(self.system_audio),
                    }),
                    ..Default::default()
                }));
                update.outbound.push(desktop(DesktopClient {
                    capture_display: Some(CaptureDisplay {
                        display_id: Some(String::new()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }));
            } else if self.media_requested && previous.can_view() != current.can_view() {
                update.outbound.push(Control {
                    media_control: Some(MediaControl {
                        stream_id: Some("desktopvideo".into()),
                        suspend: Some(!current.can_view()),
                    }),
                    ..Default::default()
                });
                if self.system_audio {
                    update.outbound.push(Control {
                        media_control: Some(MediaControl {
                            stream_id: Some("desktopaudio".into()),
                            suspend: Some(!current.can_view()),
                        }),
                        ..Default::default()
                    });
                }
            }
            if previous.can_view() != current.can_view() {
                self.cursor = Default::default();
                update.outbound.push(desktop(DesktopClient {
                    pointer_request: Some(PointerRequest {
                        push_images: Some(current.can_view()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }));
            }
        }
        if message.ping.is_some() {
            self.last_pong_ms = now_ms;
        }
        if let Some(server) = message.desktop_server {
            if let Some(pointer) = server.pointer_update
                && self.permissions.can_view()
            {
                match self.cursor.receive(pointer) {
                    Ok(request) => {
                        if let Some(request) = request {
                            update.outbound.push(desktop(DesktopClient {
                                pointer_request: Some(request),
                                ..Default::default()
                            }));
                        }
                        update.events.push(Event::Cursor(self.cursor.state.clone()));
                    }
                    Err(error) => return self.fail(error),
                }
            }
            if let Some(displays) = server.display_config
                && self.permissions.can_view()
            {
                if !valid_displays(&displays) {
                    return self.fail(SessionError::InvalidPeerMessage);
                }
                update.events.push(Event::Displays(displays));
            }
            if let Some(clipboard) = server.clipboard
                && self.permissions.can_clipboard()
                && self.clipboard_enabled
            {
                if !valid_clipboard(&clipboard) {
                    return self.fail(SessionError::InvalidPeerMessage);
                }
                update.events.push(Event::Clipboard(clipboard));
            }
        }
        Ok(update)
    }

    /// Select an advertised monitor only after the host grants viewing access.
    pub fn select_display(&self, id: String) -> Result<Control, SessionError> {
        if self.state != State::Authorized || !self.permissions.can_view() {
            return Err(SessionError::PermissionDenied);
        }
        if id.len() > 1024 {
            return Err(SessionError::InvalidInput);
        }
        Ok(desktop(DesktopClient {
            capture_display: Some(CaptureDisplay {
                display_id: Some(id),
                ..Default::default()
            }),
            ..Default::default()
        }))
    }

    pub fn authenticate(
        &mut self,
        username: String,
        password: String,
    ) -> Result<Control, SessionError> {
        if self.state != State::AwaitingCredentials {
            return Err(SessionError::WrongState);
        }
        if self
            .peer
            .as_ref()
            .is_none_or(|peer| peer.supports_local_auth != Some(true))
        {
            return Err(SessionError::UnsupportedAuthentication);
        }
        if username.is_empty() || username.len() > 1024 || password.len() > 4096 {
            return Err(SessionError::InvalidInput);
        }
        self.state = State::Authenticating;
        Ok(Control {
            auth: Some(HostAuth {
                userpass: Some(UsernamePassword {
                    username: Some(username),
                    password: Some(password),
                }),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    pub fn input(&mut self, input: InputEvent) -> Result<Control, SessionError> {
        self.require_control()?;
        if input.text.is_some() && !self.supports_text_input() {
            return Err(SessionError::UnsupportedTextInput);
        }
        if !valid_input(&input) {
            return Err(SessionError::InvalidInput);
        }
        if let Some(key) = &input.key {
            let code = key.usb_keycode.unwrap_or(0);
            if key.pressed == Some(true) {
                if self.held_keys.len() >= 256 && !self.held_keys.contains(&code) {
                    return Err(SessionError::InvalidInput);
                }
                self.held_keys.insert(code);
            } else {
                self.held_keys.remove(&code);
            }
        }
        if let Some(text) = &input.text {
            let value = text.text.as_deref().unwrap_or_default();
            if text.down == Some(true) {
                if self.held_text.len() >= 32 && !self.held_text.contains(value) {
                    return Err(SessionError::InvalidInput);
                }
                self.held_text.insert(value.to_owned());
            } else {
                self.held_text.remove(value);
            }
        }
        if let Some(mouse) = &input.mouse {
            self.pointer.x = mouse.x.or(self.pointer.x);
            self.pointer.y = mouse.y.or(self.pointer.y);
            if mouse.position.is_some() {
                self.pointer.position = mouse.position.clone();
            }
            if let Some(button) = mouse.button {
                if mouse.button_down == Some(true) {
                    self.held_buttons.insert(button);
                } else {
                    self.held_buttons.remove(&button);
                }
            }
        }
        Ok(desktop(DesktopClient {
            input: Some(input),
            ..Default::default()
        }))
    }

    pub fn release_inputs(&mut self) -> Vec<Control> {
        let keys = std::mem::take(&mut self.held_keys);
        let text = std::mem::take(&mut self.held_text);
        let buttons = std::mem::take(&mut self.held_buttons);
        let mut messages = Vec::with_capacity(keys.len() + text.len() + buttons.len());
        for key in keys {
            messages.push(desktop(DesktopClient {
                input: Some(InputEvent {
                    key: Some(KeyInput {
                        usb_keycode: Some(key),
                        pressed: Some(false),
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }));
        }
        for value in text {
            messages.push(desktop(DesktopClient {
                input: Some(InputEvent {
                    text: Some(TextInput {
                        text: Some(value),
                        down: Some(false),
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }));
        }
        for button in buttons {
            let mut mouse = self.pointer.clone();
            mouse.button = Some(button);
            mouse.button_down = Some(false);
            messages.push(desktop(DesktopClient {
                input: Some(InputEvent {
                    mouse: Some(mouse),
                    ..Default::default()
                }),
                ..Default::default()
            }));
        }
        messages
    }

    pub fn set_view_only(&mut self, value: bool) -> Vec<Control> {
        self.view_only = value;
        if value {
            self.release_inputs()
        } else {
            Vec::new()
        }
    }

    pub fn set_clipboard_enabled(&mut self, value: bool) {
        self.clipboard_enabled = value;
    }

    pub fn clipboard(&self, clipboard: Clipboard) -> Result<Control, SessionError> {
        if self.state != State::Authorized
            || !self.permissions.can_clipboard()
            || !self.clipboard_enabled
        {
            return Err(SessionError::PermissionDenied);
        }
        if !valid_clipboard(&clipboard) {
            return Err(SessionError::InvalidInput);
        }
        Ok(desktop(DesktopClient {
            clipboard: Some(clipboard),
            ..Default::default()
        }))
    }

    pub fn tick(&mut self, generation: u64, now_ms: u64) -> Result<Option<Control>, SessionError> {
        if generation != self.generation || matches!(self.state, State::Disconnected | State::Ended)
        {
            return Ok(None);
        }
        if now_ms.saturating_sub(self.last_pong_ms) > 60_000 {
            return self.fail(SessionError::Timeout);
        }
        if now_ms.saturating_sub(self.last_ping_ms) >= 30_000 {
            self.last_ping_ms = now_ms;
            return Ok(Some(Control {
                ping: Some(Empty {}),
                ..Default::default()
            }));
        }
        Ok(None)
    }
}

fn desktop(client: DesktopClient) -> Control {
    Control {
        desktop_client: Some(client),
        ..Default::default()
    }
}

fn valid_input(input: &InputEvent) -> bool {
    let kinds = usize::from(input.mouse.is_some())
        + usize::from(input.key.is_some())
        + usize::from(input.text.is_some());
    if kinds != 1 {
        return false;
    }
    if let Some(mouse) = &input.mouse
        && (mouse
            .button
            .is_some_and(|button| !(1..=3).contains(&button))
            || mouse.button.is_some() != mouse.button_down.is_some()
            || mouse.wheel_delta_x.is_some_and(|value| !value.is_finite())
            || mouse.wheel_delta_y.is_some_and(|value| !value.is_finite())
            || mouse
                .position
                .as_ref()
                .is_some_and(|point| !point.x.is_finite() || !point.y.is_finite()))
    {
        return false;
    }
    if let Some(key) = &input.key
        && (key.usb_keycode.is_none_or(|code| code == 0) || key.pressed.is_none())
    {
        return false;
    }
    if let Some(text) = &input.text
        && (text
            .text
            .as_ref()
            .is_none_or(|text| text.len() > MAX_TEXT_BYTES)
            || text.down.is_none())
    {
        return false;
    }
    true
}

fn valid_clipboard(clipboard: &Clipboard) -> bool {
    clipboard
        .available
        .as_ref()
        .is_none_or(|value| value.types.len() <= 32)
        && clipboard
            .content
            .as_ref()
            .and_then(|value| value.content.as_ref())
            .is_none_or(|value| value.len() <= MAX_CLIPBOARD_BYTES)
}

fn valid_displays(config: &DisplayConfig) -> bool {
    config.displays.len() <= 32
        && config
            .current_display_id
            .as_ref()
            .is_none_or(|id| id.len() <= 1024)
        && config.displays.iter().all(|display| {
            display.id.as_ref().is_none_or(|id| id.len() <= 1024)
                && display
                    .scale_factor
                    .is_none_or(|scale| scale.is_finite() && scale > 0.0 && scale <= 16.0)
                && display.pixels.as_ref().is_none_or(|size| {
                    (1..=16384).contains(&size.width) && (1..=16384).contains(&size.height)
                })
                && [&display.capture_rect, &display.local_rect]
                    .into_iter()
                    .flatten()
                    .all(|rect| {
                        (1..=16384).contains(&rect.width) && (1..=16384).contains(&rect.height)
                    })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_approval_timeout_retains_its_reason_and_ends_the_session() {
        use prost::Message as _;
        let mut session = Session::default();
        session.open(0, true, false);
        // Control.error: authentication failure (6), interactive timeout (3).
        let message = Control::decode(&[0x22, 0x04, 0x08, 0x06, 0x18, 0x03][..]).unwrap();
        let update = session.receive(session.generation(), message, 1).unwrap();
        assert_eq!(session.state(), State::Ended);
        assert!(!session.permissions().can_view());
        assert!(!session.permissions().can_control());
        assert!(update.outbound.is_empty());
        assert!(matches!(
            update.events.as_slice(),
            [Event::PeerEnded {
                code: 6,
                interactive_failure: Some(3)
            }]
        ));
        assert!(session.input(key(true)).is_err());
    }

    #[test]
    fn explicit_computer_login_requires_the_hosts_local_auth_capability() {
        for supported in [Some(true), Some(false), None] {
            let mut session = Session::default();
            session.open(0, false, false);
            let result = session.receive(
                session.generation(),
                Control {
                    peer_info: Some(PeerInfo {
                        supports_interactive_auth: Some(true),
                        supports_local_auth: supported,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                1,
            );
            if supported != Some(true) {
                assert!(matches!(
                    result,
                    Err(SessionError::UnsupportedAuthentication)
                ));
                assert_eq!(session.state(), State::Ended);
                assert!(!session.permissions().can_view());
                assert_eq!(
                    session.authenticate("synthetic-user".into(), "synthetic-password".into()),
                    Err(SessionError::WrongState)
                );
                continue;
            }
            let update = result.unwrap();
            assert!(
                update.outbound.is_empty(),
                "Computer login must not request interactive approval"
            );
            assert!(matches!(
                update.events.as_slice(),
                [Event::NeedHostCredentials]
            ));
            let result = session.authenticate("synthetic-user".into(), "synthetic-password".into());
            let auth = result.unwrap().auth.unwrap();
            assert!(auth.userpass.is_some());
            assert!(auth.interactive.is_none());
            assert_eq!(session.state(), State::Authenticating);
            assert!(!session.permissions().can_view());
        }
    }

    #[test]
    fn approval_choice_never_falls_back_to_computer_credentials() {
        for supported in [Some(false), None] {
            let mut session = Session::default();
            session.open(0, true, false);
            let result = session.receive(
                session.generation(),
                Control {
                    peer_info: Some(PeerInfo {
                        supports_interactive_auth: supported,
                        supports_local_auth: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                1,
            );
            assert!(matches!(
                result,
                Err(SessionError::UnsupportedAuthentication)
            ));
            assert_eq!(session.state(), State::Ended);
            assert!(!session.permissions().can_view());
            assert!(!session.permissions().can_control());
        }
    }

    fn key(down: bool) -> InputEvent {
        InputEvent {
            key: Some(KeyInput {
                usb_keycode: Some(0x70004),
                pressed: Some(down),
            }),
            ..Default::default()
        }
    }
    fn grant(session: &mut Session, mask: u32) -> Update {
        session
            .receive(
                session.generation(),
                Control {
                    auth: Some(HostAuth {
                        access_mask_updated: Some(mask),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                100,
            )
            .unwrap()
    }
    fn authenticated() -> Session {
        let mut session = Session::default();
        session.open(0, true, true);
        let reply = session
            .receive(
                session.generation(),
                Control {
                    peer_info: Some(PeerInfo {
                        supports_interactive_auth: Some(true),
                        supports_text_inject_up_down: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                10,
            )
            .unwrap();
        assert_eq!(reply.events, [Event::WaitingForHostApproval]);
        grant(&mut session, 7);
        session
    }

    #[test]
    fn cursor_cache_and_subscriptions_follow_view_grants_and_reopened_sessions() {
        let mut session = authenticated();
        let changed = Control {
            desktop_server: Some(DesktopServer {
                pointer_update: Some(PointerUpdate {
                    changed: Some(PointerChanged {
                        pointer_id: Some("arrow".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let receive = |session: &mut Session, message| {
            session.receive(session.generation(), message, 20).unwrap()
        };
        assert_eq!(receive(&mut session, changed.clone()).outbound.len(), 1);
        let bitmap = Control {
            desktop_server: Some(DesktopServer {
                pointer_update: Some(PointerUpdate {
                    image: Some(PointerImage {
                        pointer_id: Some("arrow".into()),
                        image: Some(PointerBitmap {
                            size: Some(Size {
                                width: 1,
                                height: 1,
                            }),
                            format: Some(1),
                            pixels: Some(vec![255; 4]),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(
            matches!(&receive(&mut session, bitmap.clone()).events[0], Event::Cursor(state) if state.image.is_some())
        );
        assert!(receive(&mut session, changed.clone()).outbound.is_empty());
        let revoked = grant(&mut session, 0);
        assert_eq!(
            revoked
                .outbound
                .last()
                .unwrap()
                .desktop_client
                .as_ref()
                .unwrap()
                .pointer_request
                .as_ref()
                .unwrap()
                .push_images,
            Some(false)
        );
        assert!(receive(&mut session, bitmap).events.is_empty());
        let granted = grant(&mut session, 7);
        assert_eq!(
            granted
                .outbound
                .last()
                .unwrap()
                .desktop_client
                .as_ref()
                .unwrap()
                .pointer_request
                .as_ref()
                .unwrap()
                .push_images,
            Some(true)
        );
        assert_eq!(receive(&mut session, changed.clone()).outbound.len(), 1);
        let old_generation = session.generation();
        session.open(30, true, false);
        assert!(session.cursor.state.image.is_none());
        assert!(
            session
                .receive(old_generation, changed, 31)
                .unwrap()
                .events
                .is_empty()
        );
    }

    #[test]
    fn desktop_is_requested_only_after_authentication_and_view_permission() {
        let mut session = Session::default();
        let hello = session.open(0, false, false);
        assert!(
            hello
                .peer_info
                .unwrap()
                .supported_compression_types
                .is_empty()
        );
        assert_eq!(
            session.input(key(true)),
            Err(SessionError::PermissionDenied)
        );
        let reply = session
            .receive(
                session.generation(),
                Control {
                    peer_info: Some(PeerInfo {
                        supports_local_auth: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                1,
            )
            .unwrap();
        assert_eq!(reply.events, [Event::NeedHostCredentials]);
        assert!(reply.outbound.is_empty());
        session
            .authenticate("test-user".into(), "test-pass".into())
            .unwrap();
        assert!(grant(&mut session, CONTROL).outbound.is_empty());
        assert_eq!(
            session.input(key(true)),
            Err(SessionError::PermissionDenied)
        );
        let update = grant(&mut session, VIEW);
        assert_eq!(update.outbound.len(), 3);
        assert_eq!(
            update.outbound[0]
                .desktop_client
                .as_ref()
                .unwrap()
                .add_media
                .as_ref()
                .unwrap()
                .add_system_audio,
            Some(false)
        );
        assert!(grant(&mut session, VIEW).outbound.is_empty());
    }

    #[test]
    fn selecting_displays_requires_view_permission_and_bounded_ids() {
        let mut session = authenticated();
        let selected = session.select_display("display-2".into()).unwrap();
        assert_eq!(
            selected
                .desktop_client
                .unwrap()
                .capture_display
                .unwrap()
                .display_id
                .as_deref(),
            Some("display-2")
        );
        assert_eq!(
            session.select_display("x".repeat(1025)),
            Err(SessionError::InvalidInput)
        );
        grant(&mut session, 0);
        assert_eq!(
            session.select_display("display-2".into()),
            Err(SessionError::PermissionDenied)
        );
    }

    #[test]
    fn mac_committed_text_is_inserted_once_without_a_held_text_key() {
        let mut session = authenticated();
        session.peer.as_mut().unwrap().os_type = Some(1);
        session.input(key(true)).unwrap();
        let messages = session.commit_text("AX café 🦀".into()).unwrap();
        assert_eq!(messages.len(), 2);
        let release = messages[0]
            .desktop_client
            .as_ref()
            .unwrap()
            .input
            .as_ref()
            .unwrap();
        assert_eq!(release.key.as_ref().unwrap().pressed, Some(false));
        let text = messages[1]
            .desktop_client
            .as_ref()
            .unwrap()
            .input
            .as_ref()
            .unwrap()
            .text
            .as_ref()
            .unwrap();
        assert_eq!(text.text.as_deref(), Some("AX café 🦀"));
        assert_eq!(text.down, Some(false));
        assert!(session.release_inputs().is_empty());
        session.set_view_only(true);
        assert_eq!(
            session.commit_text("blocked".into()),
            Err(SessionError::PermissionDenied)
        );
    }

    #[test]
    fn windows_text_edges_follow_utf16_units_and_release_held_input() {
        for (value, expected_edges) in [
            ("a", vec![Some(true), Some(false)]),
            ("é", vec![Some(true), Some(false)]),
            (" ", vec![Some(true), Some(false)]),
            ("🦀", vec![Some(false)]),
            ("XY", vec![Some(false)]),
            ("e\u{301}", vec![Some(false)]),
            ("Windows café 🦀", vec![Some(false)]),
        ] {
            let mut session = authenticated();
            session.peer.as_mut().unwrap().os_type = Some(0);
            session.input(key(true)).unwrap();
            let messages = session.commit_text(value.into()).unwrap();
            let release = messages[0]
                .desktop_client
                .as_ref()
                .unwrap()
                .input
                .as_ref()
                .unwrap()
                .key
                .as_ref()
                .unwrap();
            assert_eq!(release.pressed, Some(false));
            let edges: Vec<_> = messages[1..]
                .iter()
                .map(|message| {
                    let text = message
                        .desktop_client
                        .as_ref()
                        .unwrap()
                        .input
                        .as_ref()
                        .unwrap()
                        .text
                        .as_ref()
                        .unwrap();
                    assert_eq!(text.text.as_deref(), Some(value));
                    text.down
                })
                .collect();
            assert_eq!(edges, expected_edges, "{value:?}");
            assert!(session.release_inputs().is_empty());
        }
    }

    #[test]
    fn mac_single_character_commits_include_the_press_and_release() {
        let mut session = authenticated();
        session.peer.as_mut().unwrap().os_type = Some(1);
        for value in ["a", "X", "é", "🦀", " "] {
            let messages = session.commit_text(value.into()).unwrap();
            let edges: Vec<_> = messages
                .iter()
                .map(|message| {
                    let text = message
                        .desktop_client
                        .as_ref()
                        .unwrap()
                        .input
                        .as_ref()
                        .unwrap()
                        .text
                        .as_ref()
                        .unwrap();
                    assert_eq!(text.text.as_deref(), Some(value));
                    text.down
                })
                .collect();
            assert_eq!(edges, [Some(true), Some(false)]);
            assert!(session.release_inputs().is_empty());
        }
        for value in ["XY", "🦀🦀", "e\u{301}"] {
            let messages = session.commit_text(value.into()).unwrap();
            assert_eq!(messages.len(), 1);
            assert_eq!(
                messages[0]
                    .desktop_client
                    .as_ref()
                    .unwrap()
                    .input
                    .as_ref()
                    .unwrap()
                    .text
                    .as_ref()
                    .unwrap()
                    .down,
                Some(false)
            );
            assert!(session.release_inputs().is_empty());
        }
    }

    #[test]
    fn committed_text_requires_capability_and_releases_modifiers() {
        let mut session = authenticated();
        session
            .input(InputEvent {
                key: Some(KeyInput {
                    usb_keycode: Some(0x700e1),
                    pressed: Some(true),
                }),
                ..Default::default()
            })
            .unwrap();
        let messages = session.commit_text("é 🦀 日本語".into()).unwrap();
        assert_eq!(messages.len(), 3);
        let release = messages[0]
            .desktop_client
            .as_ref()
            .unwrap()
            .input
            .as_ref()
            .unwrap()
            .key
            .as_ref()
            .unwrap();
        assert_eq!(
            (release.usb_keycode, release.pressed),
            (Some(0x700e1), Some(false))
        );
        for (message, down) in messages[1..].iter().zip([true, false]) {
            let text = message
                .desktop_client
                .as_ref()
                .unwrap()
                .input
                .as_ref()
                .unwrap()
                .text
                .as_ref()
                .unwrap();
            assert_eq!(text.text.as_deref(), Some("é 🦀 日本語"));
            assert_eq!(text.down, Some(down));
        }
        assert!(session.release_inputs().is_empty());
        session.peer.as_mut().unwrap().supports_text_inject_up_down = Some(false);
        assert_eq!(
            session.commit_text("é".into()),
            Err(SessionError::UnsupportedTextInput)
        );
        session.peer.as_mut().unwrap().supports_text_inject_up_down = Some(true);
        assert_eq!(
            session.commit_text("🦀".repeat(MAX_TEXT_BYTES / 4 + 1)),
            Err(SessionError::InvalidInput)
        );
        session.set_view_only(true);
        assert_eq!(
            session.commit_text("é".into()),
            Err(SessionError::PermissionDenied)
        );
    }

    #[test]
    fn shortcuts_use_fluid_os_values_and_leave_no_held_keys() {
        for (os, modifier) in [(0, 0x700e0), (1, 0x700e3), (2, 0x700e0)] {
            let mut session = authenticated();
            session.peer.as_mut().unwrap().os_type = Some(os);
            let controls = session.shortcut(Shortcut::Copy).unwrap();
            let keys: Vec<_> = controls
                .iter()
                .map(|c| {
                    let key = c
                        .desktop_client
                        .as_ref()
                        .unwrap()
                        .input
                        .as_ref()
                        .unwrap()
                        .key
                        .as_ref()
                        .unwrap();
                    (key.usb_keycode.unwrap(), key.pressed.unwrap())
                })
                .collect();
            assert_eq!(
                keys,
                [
                    (modifier, true),
                    (0x70006, true),
                    (0x70006, false),
                    (modifier, false)
                ]
            );
            assert!(session.release_inputs().is_empty());
            grant(&mut session, 1);
            assert_eq!(
                session.shortcut(Shortcut::Paste),
                Err(SessionError::PermissionDenied)
            );
        }
    }

    #[test]
    fn remote_escape_and_caps_lock_are_single_key_taps() {
        let mut session = authenticated();
        for (shortcut, code) in [(Shortcut::Escape, 0x70029), (Shortcut::CapsLock, 0x70039)] {
            let messages = session.shortcut(shortcut).unwrap();
            assert_eq!(messages.len(), 2);
            for (message, pressed) in messages.iter().zip([true, false]) {
                let key = message
                    .desktop_client
                    .as_ref()
                    .unwrap()
                    .input
                    .as_ref()
                    .unwrap()
                    .key
                    .as_ref()
                    .unwrap();
                assert_eq!((key.usb_keycode, key.pressed), (Some(code), Some(pressed)));
            }
        }
    }

    #[test]
    fn paste_checks_both_permissions_and_sends_content_before_shortcut() {
        let mut session = authenticated();
        session.input(key(true)).unwrap();
        assert_eq!(
            session.paste_text(b"test"),
            Err(SessionError::PermissionDenied)
        );
        assert_eq!(
            session.release_inputs().len(),
            1,
            "Rejected paste must not modify held input"
        );
        session.set_clipboard_enabled(true);
        assert_eq!(session.paste_text(&[0xff]), Err(SessionError::InvalidInput));
        assert_eq!(
            session.paste_text(&vec![b'x'; MAX_CLIPBOARD_BYTES + 1]),
            Err(SessionError::InvalidInput)
        );
        let messages = session.paste_text("clipboard 🦀".as_bytes()).unwrap();
        assert_eq!(
            messages[0]
                .desktop_client
                .as_ref()
                .unwrap()
                .clipboard
                .as_ref()
                .unwrap()
                .available
                .as_ref()
                .unwrap()
                .types,
            [1]
        );
        let content = messages[1]
            .desktop_client
            .as_ref()
            .unwrap()
            .clipboard
            .as_ref()
            .unwrap()
            .content
            .as_ref()
            .unwrap();
        assert_eq!(content.content_type, Some(1));
        assert_eq!(content.content.as_deref(), Some("clipboard 🦀".as_bytes()));
        assert!(
            messages[2..]
                .iter()
                .all(|c| c.desktop_client.as_ref().unwrap().input.is_some())
        );
        assert!(session.release_inputs().is_empty());
        grant(&mut session, 3);
        assert_eq!(
            session.paste_text(b"test"),
            Err(SessionError::PermissionDenied)
        );
    }

    #[test]
    fn zero_permission_update_releases_held_inputs_suspends_media_and_blocks_new_input() {
        let mut session = authenticated();
        session.input(key(true)).unwrap();
        session
            .input(InputEvent {
                mouse: Some(MouseInput {
                    x: Some(500),
                    y: Some(40),
                    button: Some(3),
                    button_down: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap();
        let update = grant(&mut session, 0);
        assert_eq!(session.permissions(), Permissions(0));
        assert_eq!(update.outbound.len(), 5);
        let released_key = update.outbound[0]
            .desktop_client
            .as_ref()
            .unwrap()
            .input
            .as_ref()
            .unwrap()
            .key
            .as_ref()
            .unwrap();
        assert_eq!(released_key.pressed, Some(false));
        let released_mouse = update.outbound[1]
            .desktop_client
            .as_ref()
            .unwrap()
            .input
            .as_ref()
            .unwrap()
            .mouse
            .as_ref()
            .unwrap();
        assert_eq!(
            (released_mouse.x, released_mouse.button_down),
            (Some(500), Some(false))
        );
        assert_eq!(
            update.outbound[2].media_control.as_ref().unwrap().suspend,
            Some(true)
        );
        assert_eq!(
            update.outbound[3]
                .media_control
                .as_ref()
                .unwrap()
                .stream_id
                .as_deref(),
            Some("desktopaudio")
        );
        assert_eq!(
            session.input(key(true)),
            Err(SessionError::PermissionDenied)
        );
        assert!(session.release_inputs().is_empty());
    }

    #[test]
    fn view_only_releases_keys_and_clipboard_needs_explicit_opt_in() {
        let mut session = authenticated();
        session.input(key(true)).unwrap();
        session
            .input(InputEvent {
                text: Some(TextInput {
                    text: Some("é".into()),
                    down: Some(true),
                }),
                ..Default::default()
            })
            .unwrap();
        let releases = session.set_view_only(true);
        assert_eq!(releases.len(), 2);
        assert_eq!(
            releases[1]
                .desktop_client
                .as_ref()
                .unwrap()
                .input
                .as_ref()
                .unwrap()
                .text
                .as_ref()
                .unwrap()
                .down,
            Some(false)
        );
        assert_eq!(
            session.input(key(true)),
            Err(SessionError::PermissionDenied)
        );
        assert_eq!(
            session.clipboard(Clipboard::default()),
            Err(SessionError::PermissionDenied)
        );
        session.set_clipboard_enabled(true);
        assert!(session.clipboard(Clipboard::default()).is_ok());
        grant(&mut session, VIEW);
        assert_eq!(
            session.clipboard(Clipboard::default()),
            Err(SessionError::PermissionDenied)
        );
    }

    #[test]
    fn old_callbacks_cannot_reauthorize_reopened_or_closed_sessions() {
        let mut session = authenticated();
        let old = session.generation();
        session.open(200, true, true);
        let reply = session
            .receive(
                old,
                Control {
                    auth: Some(HostAuth {
                        access_mask_updated: Some(7),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                201,
            )
            .unwrap();
        assert!(reply.events.is_empty());
        assert_eq!(session.state(), State::Negotiating);
        assert_eq!(session.permissions(), Permissions(0));
        session.close();
        assert!(session.tick(old, 500_000).unwrap().is_none());
    }

    #[test]
    fn unsolicited_auth_grants_and_unnegotiated_compression_end_the_session() {
        let mut session = Session::default();
        session.open(0, true, true);
        let grant = Control {
            auth: Some(HostAuth {
                access_mask_updated: Some(7),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            session.receive(session.generation(), grant, 1).unwrap_err(),
            SessionError::InvalidPeerMessage
        );
        assert_eq!(session.state(), State::Ended);
        session.open(0, true, true);
        assert_eq!(
            session
                .receive(
                    session.generation(),
                    Control {
                        compression_start: Some(CompressionStart {
                            compression_type: Some(1)
                        }),
                        ..Default::default()
                    },
                    1
                )
                .unwrap_err(),
            SessionError::UnsupportedCompression
        );
    }

    #[test]
    fn timeout_uses_session_time_and_peer_ping_extends_the_deadline() {
        let mut session = authenticated();
        assert!(
            session
                .tick(session.generation(), 30_000)
                .unwrap()
                .unwrap()
                .ping
                .is_some()
        );
        session
            .receive(
                session.generation(),
                Control {
                    ping: Some(Empty {}),
                    ..Default::default()
                },
                35_000,
            )
            .unwrap();
        assert!(session.tick(session.generation(), 90_000).is_ok());
        assert_eq!(
            session.tick(session.generation(), 95_001),
            Err(SessionError::Timeout)
        );
    }

    #[test]
    fn invalid_input_and_display_geometry_are_rejected() {
        let mut session = authenticated();
        assert_eq!(
            session.input(InputEvent {
                mouse: Some(MouseInput {
                    wheel_delta_y: Some(f32::NAN),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            Err(SessionError::InvalidInput)
        );
        let message = Control {
            desktop_server: Some(DesktopServer {
                display_config: Some(DisplayConfig {
                    current_display_id: None,
                    displays: vec![DisplayInfo {
                        pixels: Some(Size {
                            width: u32::MAX,
                            height: 1080,
                        }),
                        ..Default::default()
                    }],
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            session
                .receive(session.generation(), message, 1)
                .unwrap_err(),
            SessionError::InvalidPeerMessage
        );
        assert_eq!(session.state(), State::Ended);
    }
}
