use crate::{
    jump_bridge::Bridge,
    jump_input,
    jump_runtime::{Action, Command, Snapshot},
};
use crabfleet_cloud::{
    account::State as AccountState,
    auth::{Credentials, Secret},
};
use crabfleet_fluid::session::{Shortcut, State};
use eframe::egui::{self, Color32, RichText, Vec2};
use std::time::Duration;
use zeroize::Zeroize;

const BACKGROUND: Color32 = Color32::from_rgb(13, 20, 25);
const PANEL: Color32 = Color32::from_rgb(20, 30, 36);
const ACCENT: Color32 = Color32::from_rgb(109, 229, 188);
const MUTED: Color32 = Color32::from_rgb(142, 159, 168);
const WARNING: Color32 = Color32::from_rgb(242, 168, 132);

pub struct JumpViewer {
    bridge: Bridge,
    snapshot: Snapshot,
    epoch: u64,
    now_ms: u64,
    email: String,
    password: String,
    passcode: String,
    recovery: bool,
    host_username: String,
    host_password: String,
    search: String,
    interactive_auth: bool,
    clipboard_text: String,
    clipboard_revision: u64,
    texture: Option<egui::TextureHandle>,
    pending_frame: Option<crabfleet_rtc::VideoFrame>,
    cursor: crate::jump_cursor::Painter,
    dimensions: [u32; 2],
    frames: u64,
    capture: jump_input::Capture,
    discard_input: bool,
    view_only: bool,
    audio: bool,
    clipboard_enabled: bool,
    fullscreen: bool,
    error: Option<String>,
    fatal: bool,
    #[cfg(not(target_arch = "wasm32"))]
    pub screenshot: Option<std::path::PathBuf>,
    #[cfg(not(target_arch = "wasm32"))]
    screenshot_requested: bool,
}
impl JumpViewer {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let mut style = (*cc.egui_ctx.global_style()).clone();
        style.visuals = egui::Visuals::dark();
        style.visuals.panel_fill = PANEL;
        style.visuals.window_fill = PANEL;
        style.visuals.extreme_bg_color = BACKGROUND;
        style.visuals.selection.bg_fill = Color32::from_rgb(38, 83, 72);
        style.visuals.selection.stroke.color = ACCENT;
        style.visuals.override_text_color = Some(Color32::from_rgb(226, 235, 233));
        style.spacing.item_spacing = Vec2::new(10.0, 10.0);
        style.spacing.button_padding = Vec2::new(12.0, 8.0);
        style
            .text_styles
            .insert(egui::TextStyle::Body, egui::FontId::proportional(15.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, egui::FontId::proportional(14.0));
        cc.egui_ctx.set_global_style(style);
        Self {
            bridge: Bridge::new(cc.egui_ctx.clone()),
            snapshot: Snapshot::default(),
            epoch: 0,
            now_ms: 0,
            email: String::new(),
            password: String::new(),
            passcode: String::new(),
            recovery: false,
            host_username: String::new(),
            host_password: String::new(),
            search: String::new(),
            interactive_auth: true,
            clipboard_text: String::new(),
            clipboard_revision: 0,
            texture: None,
            pending_frame: None,
            cursor: Default::default(),
            dimensions: [0, 0],
            frames: 0,
            capture: Default::default(),
            discard_input: false,
            view_only: false,
            audio: false,
            clipboard_enabled: false,
            fullscreen: false,
            error: None,
            fatal: false,
            #[cfg(not(target_arch = "wasm32"))]
            screenshot: None,
            #[cfg(not(target_arch = "wasm32"))]
            screenshot_requested: false,
        }
    }
    fn send(&mut self, action: Action) {
        if self.fatal {
            return;
        }
        if action.resets_session() {
            self.epoch = self.epoch.wrapping_add(1);
            self.clear_remote();
            self.host_password.zeroize();
            self.passcode.zeroize();
            self.clipboard_text.zeroize();
            self.error = None;
        }
        if let Err(error) = self.bridge.send(
            Command {
                epoch: self.epoch,
                media_revision: self.snapshot.media_revision,
                action,
            },
            self.now_ms,
        ) {
            self.clear_remote();
            self.error = Some(error.into());
            self.fatal = true;
        }
    }
    fn clear_remote(&mut self) {
        self.texture = None;
        self.pending_frame = None;
        self.cursor = Default::default();
        self.capture.reset();
        self.dimensions = [0, 0];
    }
    fn release(&mut self) {
        if self.capture.release() {
            self.send(Action::Release);
        }
    }
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn release_input(&mut self) {
        self.release();
        self.discard_input = true;
    }
    fn poll(&mut self) {
        let update = self.bridge.poll(self.now_ms);
        if self.fatal || update.snapshot.epoch != self.epoch {
            return;
        }
        if !update.snapshot.permissions.can_view()
            || update.snapshot.media_revision != self.snapshot.media_revision
        {
            self.clear_remote();
        }
        if update.snapshot.media_revision != self.snapshot.media_revision {
            self.host_password.zeroize();
        }
        if !update.snapshot.permissions.can_control() {
            self.release();
        }
        if update.snapshot.clipboard_revision != self.clipboard_revision {
            self.clipboard_text.zeroize();
            self.clipboard_text.push_str(&update.snapshot.clipboard);
            self.clipboard_revision = update.snapshot.clipboard_revision;
        }
        self.snapshot = update.snapshot;
        if let Some(frame) = update.frame {
            self.pending_frame = Some(frame);
        }
    }
    fn upload(&mut self, ctx: &egui::Context) {
        if self.snapshot.permissions.can_view() {
            self.cursor.sync(ctx, &self.snapshot.cursor);
        }
        if let Some(frame) = self.pending_frame.take() {
            self.dimensions = [frame.width, frame.height];
            let image = egui::ColorImage::from_rgba_unmultiplied(
                [frame.width as usize, frame.height as usize],
                &frame.rgba,
            );
            if let Some(texture) = &mut self.texture {
                texture.set(image, egui::TextureOptions::LINEAR);
            } else {
                self.texture =
                    Some(ctx.load_texture("jump-desktop", image, egui::TextureOptions::LINEAR));
            }
            self.frames += 1;
        }
    }
    fn state_label(&self) -> &'static str {
        if self.fatal {
            return "Viewer stopped";
        }
        if self.snapshot.recovery.is_some() && self.snapshot.computer.is_none() {
            return "Reconnecting";
        }
        if self.snapshot.computer.is_some() {
            return match self.snapshot.session {
                State::AwaitingCredentials => "Host sign-in required",
                State::Authenticating if self.snapshot.waiting_for_approval => {
                    "Waiting for host approval"
                }
                State::Authenticating => "Authenticating with host",
                State::Authorized if !self.snapshot.permissions.can_view() => {
                    "Viewing permission revoked"
                }
                State::Authorized if self.texture.is_some() => "Live session",
                State::Authorized => "Waiting for video",
                _ => "Connecting to computer",
            };
        }
        match self.snapshot.account {
            AccountState::SignedOut => "Signed out",
            AccountState::SigningIn => "Signing in",
            AccountState::PasscodeRequired | AccountState::PasscodeInvalid => {
                "Verification required"
            }
            AccountState::CaptchaRequired => "Browser challenge required",
            AccountState::Connecting => "Finding computers",
            AccountState::Ready => "Ready to connect",
            AccountState::Failed(_) => "Account connection failed",
        }
    }
    fn account_form(&mut self, ui: &mut egui::Ui) {
        ui.heading("Your computers, anywhere.");
        ui.add_space(6.0);
        ui.label(
            RichText::new("Sign in with your Jump Desktop account to find your computers.")
                .color(MUTED),
        );
        ui.add_space(20.0);
        let waiting = matches!(
            self.snapshot.account,
            AccountState::SigningIn | AccountState::Connecting
        );
        let mfa = matches!(
            self.snapshot.account,
            AccountState::PasscodeRequired | AccountState::PasscodeInvalid
        );
        if mfa {
            ui.label("Verification code");
            ui.add(
                egui::TextEdit::singleline(&mut self.passcode)
                    .password(true)
                    .char_limit(128)
                    .desired_width(f32::INFINITY),
            );
            ui.checkbox(&mut self.recovery, "Use a recovery code");
            if self.snapshot.account == AccountState::PasscodeInvalid {
                ui.colored_label(WARNING, "That code was rejected. Try a new code.");
            }
            if ui
                .add_enabled(
                    !self.passcode.is_empty(),
                    egui::Button::new("Verify and continue"),
                )
                .clicked()
            {
                let code = Secret::new(std::mem::take(&mut self.passcode));
                self.send(Action::Passcode {
                    code,
                    recovery: self.recovery,
                });
            }
        } else {
            ui.add_enabled_ui(!waiting, |ui| {
                ui.label("Email address");
                ui.add(
                    egui::TextEdit::singleline(&mut self.email)
                        .hint_text("you@example.com")
                        .char_limit(320)
                        .desired_width(f32::INFINITY),
                );
                ui.label("Password");
                let password = ui.add(
                    egui::TextEdit::singleline(&mut self.password)
                        .password(true)
                        .char_limit(4096)
                        .desired_width(f32::INFINITY),
                );
                let submit = password.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if ui
                    .add_enabled(
                        !self.email.trim().is_empty() && !self.password.is_empty(),
                        egui::Button::new("Sign in").fill(Color32::from_rgb(38, 83, 72)),
                    )
                    .clicked()
                    || submit && !self.password.is_empty()
                {
                    let credentials = Credentials {
                        email: self.email.trim().to_owned(),
                        password: Secret::new(std::mem::take(&mut self.password)),
                        passcode: None,
                        recovery_code: None,
                        captcha: None,
                    };
                    self.send(Action::SignIn(credentials));
                }
            });
        }
        if waiting {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label(self.state_label());
            });
        }
        if (waiting || mfa) && ui.button("Cancel sign-in").clicked() {
            self.send(Action::SignOut);
            self.password.zeroize();
        }
        ui.add_space(20.0);
        ui.separator();
        ui.label(RichText::new("Password and two-step verification are supported in this experimental build. Google, Apple, SSO, and browser challenges are still being integrated.").size(12.0).color(MUTED));
        ui.label(
            RichText::new("Your sign-in stays in memory for this app session.")
                .size(12.0)
                .color(MUTED),
        );
        if self.snapshot.account == AccountState::CaptchaRequired {
            ui.colored_label(
                WARNING,
                "Jump requires a browser challenge. This sign-in path cannot complete it yet.",
            );
        }
    }
    fn computers(&mut self, ui: &mut egui::Ui) {
        ui.heading("Computers");
        ui.label(RichText::new(&self.snapshot.email).small().color(MUTED));
        ui.add_space(12.0);
        ui.label(RichText::new("Host sign-in").small().color(MUTED));
        ui.radio_value(&mut self.interactive_auth, true, "Approve on computer");
        ui.radio_value(
            &mut self.interactive_auth,
            false,
            "Computer username and password",
        );
        ui.add_space(8.0);
        ui.add(
            egui::TextEdit::singleline(&mut self.search)
                .hint_text("Find a computer…")
                .char_limit(256)
                .desired_width(f32::INFINITY),
        );
        let query = self.search.to_lowercase();
        let computers = self.snapshot.computers.clone();
        let mut shown = 0;
        for computer in computers
            .iter()
            .filter(|c| c.name.to_lowercase().contains(&query))
        {
            shown += 1;
            ui.add_space(6.0);
            let selected = self.snapshot.computer.as_deref() == Some(&computer.id);
            let label = format!(
                "{}\n{}",
                computer.name,
                if selected {
                    "Selected"
                } else if computer.can_connect() {
                    "Online · Fluid"
                } else if !computer.online {
                    "Offline"
                } else {
                    "RTC v2 unavailable"
                }
            );
            if ui
                .add_enabled(
                    computer.can_connect() && !selected,
                    egui::Button::new(label)
                        .selected(selected)
                        .min_size(egui::vec2(ui.available_width(), 54.0)),
                )
                .clicked()
            {
                self.send(Action::Connect {
                    id: computer.id.clone(),
                    interactive: self.interactive_auth,
                });
            }
        }
        if shown == 0 {
            ui.add_space(16.0);
            ui.label(RichText::new(if query.is_empty() { "No computers have announced themselves yet. Check that Jump Desktop Connect is running on your computer." } else { "No matching computers." }).color(MUTED));
        }
        ui.add_space(20.0);
        ui.separator();
        ui.horizontal_wrapped(|ui| {
            if ui.button("Refresh connection").clicked() {
                self.send(Action::Reconnect);
            }
            if ui.button("Sign out").clicked() {
                self.send(Action::SignOut);
                self.password.zeroize();
            }
        });
    }
    fn toolbar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            if ui.button("Disconnect").clicked() {
                self.send(Action::Disconnect);
            }
            if ui.checkbox(&mut self.view_only, "View only").changed() {
                self.release();
                self.send(Action::ViewOnly(self.view_only));
            }
            if ui.checkbox(&mut self.audio, "Audio").changed() {
                self.send(Action::Audio(self.audio));
            }
            if ui
                .checkbox(&mut self.clipboard_enabled, "Clipboard")
                .changed()
            {
                self.release();
                self.send(Action::ClipboardEnabled(self.clipboard_enabled));
            }
            if self.capture.active && ui.button("Release control").clicked() {
                self.release();
            }
        });
        ui.horizontal_wrapped(|ui| {
            let previous = self.capture.mode;
            ui.label("Keyboard");
            ui.selectable_value(&mut self.capture.mode, jump_input::Mode::Text, "Local text");
            ui.selectable_value(
                &mut self.capture.mode,
                jump_input::Mode::Physical,
                "Physical keys",
            );
            if previous != self.capture.mode {
                self.release();
            }
            ui.add_enabled_ui(
                !self.view_only && self.snapshot.permissions.can_control(),
                |ui| {
                    ui.menu_button("Send keys", |ui| {
                        for (label, shortcut) in [
                            ("Escape", Shortcut::Escape),
                            ("Caps lock", Shortcut::CapsLock),
                            ("Copy on remote", Shortcut::Copy),
                            ("Cut on remote", Shortcut::Cut),
                            ("Paste on remote", Shortcut::Paste),
                        ] {
                            if ui.button(label).clicked() {
                                self.release();
                                self.send(Action::Shortcut(shortcut));
                                ui.close();
                            }
                        }
                    });
                },
            );
        });
        if self.snapshot.session == State::Authorized
            && self.capture.mode == jump_input::Mode::Text
            && !self.snapshot.supports_text_input
        {
            ui.label(
                RichText::new("This host has not advertised text input; using physical keys.")
                    .small()
                    .color(MUTED),
            );
        }
        if self.snapshot.audio_blocked && ui.button("Enable audio playback").clicked() {
            self.audio = true;
            self.send(Action::Audio(true));
        }
        let displays = self.snapshot.displays.clone();
        if displays.displays.len() > 1 {
            egui::ComboBox::from_id_salt("monitor")
                .selected_text("Choose display")
                .show_ui(ui, |ui| {
                    for (index, display) in displays.displays.iter().enumerate() {
                        if let Some(id) = &display.id {
                            let selected = displays.current_display_id.as_deref() == Some(id);
                            if ui
                                .selectable_label(selected, format!("Display {}", index + 1))
                                .clicked()
                            {
                                self.release();
                                self.send(Action::Display(id.clone()));
                            }
                        }
                    }
                });
        }
        if self.clipboard_enabled {
            egui::CollapsingHeader::new("Transfer clipboard text").show(ui, |ui| {
                let enabled = self.snapshot.permissions.can_clipboard();
                ui.add_enabled_ui(enabled, |ui| {
                    ui.add(
                        egui::TextEdit::multiline(&mut self.clipboard_text)
                            .desired_rows(3)
                            .char_limit(1024 * 1024)
                            .desired_width(f32::INFINITY),
                    );
                    ui.horizontal_wrapped(|ui| {
                        if ui.button("Send to remote clipboard").clicked() {
                            self.send(Action::SendClipboard(zeroize::Zeroizing::new(
                                self.clipboard_text.clone(),
                            )));
                        }
                        if ui.button("Get remote clipboard").clicked() {
                            self.send(Action::GetClipboard);
                        }
                        if ui.button("Copy text locally").clicked() {
                            ui.ctx().copy_text(self.clipboard_text.clone());
                        }
                    });
                });
                if !enabled {
                    ui.label("The host has not granted clipboard access.");
                }
            });
        }
    }
    fn host_form(&mut self, ui: &mut egui::Ui) {
        ui.heading("Sign in to this computer");
        ui.label(RichText::new("Enter the computer's local account credentials.").color(MUTED));
        ui.label("Username");
        ui.add(egui::TextEdit::singleline(&mut self.host_username).char_limit(1024));
        ui.label("Password");
        ui.add(
            egui::TextEdit::singleline(&mut self.host_password)
                .password(true)
                .char_limit(4096),
        );
        if ui
            .add_enabled(
                !self.host_username.is_empty(),
                egui::Button::new("Continue"),
            )
            .clicked()
        {
            let password = Secret::new(std::mem::take(&mut self.host_password));
            self.send(Action::HostCredentials {
                username: self.host_username.clone(),
                password,
            });
        }
    }
    fn viewport(&mut self, ui: &mut egui::Ui) {
        let available = ui.available_size().max(egui::vec2(1.0, 1.0));
        let Some(texture) = &self.texture else {
            ui.allocate_ui_with_layout(
                available,
                egui::Layout::top_down(egui::Align::Center),
                |ui| {
                    ui.add_space((available.y * 0.25).max(12.0));
                    ui.label(
                        RichText::new(if self.snapshot.computer.is_some() {
                            self.state_label()
                        } else {
                            "Select a computer to begin"
                        })
                        .size(23.0),
                    );
                    ui.add_space(10.0);
                    ui.label(
                        RichText::new(if self.snapshot.waiting_for_approval {
                            "Approve the connection on the remote computer."
                        } else {
                            "Video will appear here after the host grants access."
                        })
                        .color(MUTED),
                    );
                },
            );
            return;
        };
        let scale =
            (available.x / self.dimensions[0] as f32).min(available.y / self.dimensions[1] as f32);
        let size = egui::vec2(
            self.dimensions[0] as f32 * scale,
            self.dimensions[1] as f32 * scale,
        );
        let (area, _) = ui.allocate_exact_size(available, egui::Sense::hover());
        let rect = egui::Rect::from_center_size(area.center(), size);
        ui.painter().image(
            texture.id(),
            rect,
            egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
            Color32::WHITE,
        );
        let response = ui.interact(
            rect,
            ui.id().with("remote-image"),
            egui::Sense::click_and_drag(),
        );
        if response.hovered() && !self.view_only && self.snapshot.permissions.can_control() {
            self.cursor.paint(ui, rect, self.snapshot.cursor.visible);
        }
        // A quick click can press and release between two render passes.
        let clicked = [
            egui::PointerButton::Primary,
            egui::PointerButton::Middle,
            egui::PointerButton::Secondary,
        ]
        .into_iter()
        .any(|button| response.clicked_by(button));
        if (response.is_pointer_button_down_on() || clicked) && !response.has_focus() {
            response.request_focus();
        }
        self.input(ui, rect);
    }
    fn remote_size(&self) -> [u32; 2] {
        self.snapshot
            .displays
            .displays
            .iter()
            .find(|d| d.id == self.snapshot.displays.current_display_id)
            .and_then(|d| d.capture_rect.as_ref())
            .map(|r| [r.width as u32, r.height as u32])
            .unwrap_or(self.dimensions)
    }
    fn input(&mut self, ui: &mut egui::Ui, rect: egui::Rect) {
        let (events, modifiers, window_focused) =
            ui.input(|i| (i.events.clone(), i.modifiers, i.focused));
        let focused =
            window_focused && ui.memory(|m| m.focused() == Some(ui.id().with("remote-image")));
        let batch = self.capture.process(jump_input::FrameInput {
            events: &events,
            rect,
            size: self.remote_size(),
            focused,
            can_control: !self.view_only && self.snapshot.permissions.can_control(),
            text_supported: self.snapshot.supports_text_input,
            modifiers,
            now_ms: self.now_ms,
        });
        for action in batch.actions {
            self.send(action);
        }
        jump_input::maintain_focus(ui, self.capture.active);
        if let Some(error) = batch.error {
            self.error = Some(error.into());
        }
        if self.capture.active
            && self.capture.mode == jump_input::Mode::Text
            && self.snapshot.supports_text_input
        {
            let cursor_rect = egui::Rect::from_min_size(
                rect.left_bottom() - egui::vec2(0.0, 24.0),
                egui::vec2(1.0, 24.0),
            );
            ui.output_mut(|o| {
                o.ime = Some(egui::output::IMEOutput {
                    purpose: egui::IMEPurpose::Terminal,
                    rect,
                    cursor_rect,
                    should_interrupt_composition: false,
                })
            });
            if !self.capture.preedit().is_empty() {
                let preview: String = self.capture.preedit().chars().take(128).collect();
                ui.painter().rect_filled(
                    egui::Rect::from_min_size(cursor_rect.min, egui::vec2(rect.width(), 24.0)),
                    0,
                    PANEL,
                );
                ui.painter().text(
                    cursor_rect.min,
                    egui::Align2::LEFT_TOP,
                    preview,
                    egui::FontId::proportional(16.0),
                    ACCENT,
                );
            }
        }
    }
    pub fn diagnostics(&self) -> String {
        format!(
            "{{\"mode\":\"jump\",\"state\":\"{}\",\"frames\":{},\"capture\":{},\"viewOnly\":{}}}",
            self.state_label(),
            self.frames,
            self.capture.active,
            self.view_only
        )
    }
}
impl eframe::App for JumpViewer {
    fn raw_input_hook(&mut self, _: &egui::Context, raw: &mut egui::RawInput) {
        if let Some(time) = raw.time.filter(|time| time.is_finite()) {
            self.now_ms = self.now_ms.max((time.max(0.0) * 1000.0) as u64);
        }
        if crate::input_lifecycle::prepare(raw, &mut self.discard_input) {
            self.release();
        }
    }
    fn logic(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        self.poll();
        ctx.request_repaint_after(Duration::from_millis(33));
    }
    fn ui(&mut self, ui: &mut egui::Ui, _: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.upload(&ctx);
        egui::Panel::top("jump-header")
            .frame(egui::Frame::new().fill(PANEL).inner_margin(18))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label(
                        RichText::new("CRABFLEET")
                            .monospace()
                            .strong()
                            .size(19.0)
                            .color(ACCENT),
                    );
                    ui.label(RichText::new("/  Desktop").size(19.0));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .button(if self.fullscreen {
                                "Exit fullscreen"
                            } else {
                                "Fullscreen"
                            })
                            .clicked()
                        {
                            self.fullscreen = !self.fullscreen;
                            ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(
                                self.fullscreen,
                            ));
                        }
                        ui.label(RichText::new(self.state_label()).color(MUTED));
                    });
                });
            });
        egui::Panel::bottom("jump-footer")
            .frame(egui::Frame::new().fill(PANEL).inner_margin(10))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label(
                        RichText::new(if self.capture.active {
                            "INPUT ACTIVE · Esc to release"
                        } else {
                            "INDEPENDENT CLIENT · Experimental"
                        })
                        .monospace()
                        .size(11.0)
                        .color(if self.capture.active {
                            ACCENT
                        } else {
                            MUTED
                        }),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            RichText::new(if cfg!(target_arch = "wasm32") {
                                "WEB / WASM"
                            } else {
                                "LINUX / NATIVE"
                            })
                            .monospace()
                            .size(11.0)
                            .color(MUTED),
                        );
                    });
                });
            });
        let account_ready = self.snapshot.account == AccountState::Ready;
        let compact = ui.available_width() <= 760.0;
        if account_ready && !compact {
            egui::Panel::left("jump-computers")
                .exact_size(272.0)
                .resizable(false)
                .frame(egui::Frame::new().fill(PANEL).inner_margin(18))
                .show(ui, |ui| {
                    egui::ScrollArea::vertical().show(ui, |ui| self.computers(ui));
                });
        }
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(BACKGROUND).inner_margin(24))
            .show(ui, |ui| {
                if let Some(recovery) = self.snapshot.recovery {
                    ui.horizontal_wrapped(|ui| {
                        use crate::jump_reconnect::Stage;
                        ui.spinner();
                        ui.label(match recovery.stage {
                            Stage::Delay => format!(
                                "Reconnecting in {}s · attempt {} of 5",
                                recovery.remaining_seconds, recovery.attempt
                            ),
                            Stage::Account => {
                                format!("Reconnecting account · attempt {} of 5", recovery.attempt)
                            }
                            Stage::Computer => {
                                "Waiting for the selected computer to come online".into()
                            }
                            Stage::Host => {
                                "Restoring session · host approval or credentials may be required"
                                    .into()
                            }
                        });
                        if ui.button("Cancel recovery").clicked() {
                            self.send(Action::Disconnect);
                        }
                    });
                    ui.add_space(8.0);
                }
                if let Some(error) = self.error.as_ref().or(self.snapshot.error.as_ref()) {
                    ui.colored_label(WARNING, error);
                }
                if let AccountState::Failed(error) = self.snapshot.account {
                    ui.colored_label(WARNING, error.to_string());
                    if self.snapshot.can_reconnect && ui.button("Reconnect account").clicked() {
                        self.send(Action::Reconnect);
                    }
                }
                if !account_ready {
                    egui::ScrollArea::vertical().show(ui, |ui| {
                        ui.add_space(30.0);
                        ui.vertical_centered(|ui| {
                            ui.set_max_width(468.0);
                            egui::Frame::new()
                                .fill(PANEL)
                                .inner_margin(24)
                                .corner_radius(12)
                                .stroke(egui::Stroke::new(1.0, Color32::from_rgb(38, 52, 60)))
                                .show(ui, |ui| {
                                    ui.with_layout(
                                        egui::Layout::top_down(egui::Align::LEFT),
                                        |ui| self.account_form(ui),
                                    );
                                });
                        });
                    });
                } else {
                    if compact {
                        let max_height = ui.available_height() * 0.4;
                        egui::CollapsingHeader::new("Computers & account")
                            .default_open(self.snapshot.computer.is_none())
                            .show(ui, |ui| {
                                egui::ScrollArea::vertical()
                                    .id_salt("compact-computers")
                                    .max_height(max_height)
                                    .show(ui, |ui| self.computers(ui));
                            });
                    }
                    let computer_name = self
                        .snapshot
                        .computer
                        .as_ref()
                        .and_then(|id| self.snapshot.computers.iter().find(|c| c.id == *id))
                        .map(|c| c.name.as_str())
                        .unwrap_or("Remote desktop");
                    ui.heading(computer_name);
                    ui.label(
                        RichText::new(if self.view_only {
                            "Viewing only"
                        } else {
                            "Click the picture to control · Escape releases input"
                        })
                        .size(12.0)
                        .color(MUTED),
                    );
                    if self.snapshot.computer.is_some() {
                        self.toolbar(ui);
                    }
                    if self.snapshot.session == State::AwaitingCredentials {
                        self.host_form(ui);
                    } else {
                        ui.add_space(12.0);
                        self.viewport(ui);
                    }
                }
            });
        #[cfg(not(target_arch = "wasm32"))]
        self.capture_proof(&ctx);
    }
}
impl Drop for JumpViewer {
    fn drop(&mut self) {
        self.password.zeroize();
        self.passcode.zeroize();
        self.host_password.zeroize();
        self.clipboard_text.zeroize();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use eframe::App;

    #[test]
    fn a_complete_click_between_frames_captures_the_remote_image() {
        use crabfleet_fluid::{
            control::{Control, HostAuth, PeerInfo},
            session::Session,
        };
        let ctx = egui::Context::default();
        let cc = eframe::CreationContext::_new_kittest(ctx.clone());
        let mut viewer = JumpViewer::new(&cc);
        let mut session = Session::default();
        session.open(0, true, false);
        session
            .receive(
                session.generation(),
                Control {
                    peer_info: Some(PeerInfo {
                        supports_interactive_auth: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                1,
            )
            .unwrap();
        session
            .receive(
                session.generation(),
                Control {
                    auth: Some(HostAuth {
                        access_mask_updated: Some(3),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                2,
            )
            .unwrap();
        viewer.snapshot.permissions = session.permissions();
        viewer.dimensions = [100, 100];
        viewer.texture = Some(ctx.load_texture(
            "synthetic",
            egui::ColorImage::filled([1, 1], Color32::BLACK),
            Default::default(),
        ));
        let raw = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(300.0, 300.0),
            )),
            focused: true,
            ..Default::default()
        };
        ctx.run_ui(raw.clone(), |ui| viewer.viewport(ui))
            .textures_delta
            .clear();
        let pos = egui::pos2(150.0, 150.0);
        let mut click = raw.clone();
        click.events.push(egui::Event::PointerMoved(pos));
        for pressed in [true, false] {
            click.events.push(egui::Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed,
                modifiers: Default::default(),
            });
        }
        ctx.run_ui(click, |ui| viewer.viewport(ui))
            .textures_delta
            .clear();
        assert!(
            viewer.capture.active,
            "A quick click must acquire input focus even with no button still held"
        );
        let mut escape = raw;
        escape.events.push(egui::Event::Key {
            key: egui::Key::Escape,
            physical_key: None,
            pressed: true,
            repeat: false,
            modifiers: Default::default(),
        });
        ctx.run_ui(escape, |ui| viewer.viewport(ui))
            .textures_delta
            .clear();
        assert!(
            !viewer.capture.active,
            "Escape must still release the acquired capture"
        );
    }

    #[test]
    fn hidden_logic_polls_the_session_and_uses_fresh_time_without_a_ui_pass() {
        let ctx = egui::Context::default();
        let mut shown = ctx.run_ui(
            egui::RawInput {
                time: Some(1.0),
                ..Default::default()
            },
            |_| {},
        );
        shown.textures_delta.clear();
        let cc = eframe::CreationContext::_new_kittest(ctx.clone());
        let mut viewer = JumpViewer::new(&cc);
        viewer.capture.active = true;
        viewer.snapshot.email = "stale snapshot".into();
        let mut app = crate::Viewer::Jump(Box::new(viewer));
        let mut frame = eframe::Frame::_new_kittest();
        let mut raw = egui::RawInput {
            time: Some(61.0),
            focused: false,
            ..Default::default()
        };
        raw.viewports.get_mut(&raw.viewport_id).unwrap().occluded = Some(true);
        app.raw_input_hook(&ctx, &mut raw);
        let _ = ctx.run_logic(&raw, |ctx| app.logic(ctx, &mut frame));
        assert_eq!(ctx.input(|input| input.time), 1.0);
        let crate::Viewer::Jump(viewer) = app else {
            unreachable!()
        };
        assert_eq!(viewer.now_ms, 61_000);
        assert!(!viewer.capture.active);
        assert!(
            viewer.snapshot.email.is_empty(),
            "The hidden pass did not consume the session snapshot"
        );
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl JumpViewer {
    fn capture_proof(&mut self, ctx: &egui::Context) {
        let Some(path) = &self.screenshot else {
            return;
        };
        if self.now_ms > 1000 && !self.screenshot_requested {
            self.screenshot_requested = true;
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
        }
        for event in ctx.input(|i| i.events.clone()) {
            if let egui::Event::Screenshot { image, .. } = event {
                let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                    let mut encoder = png::Encoder::new(
                        std::fs::File::create(path)?,
                        image.width() as u32,
                        image.height() as u32,
                    );
                    encoder.set_color(png::ColorType::Rgba);
                    encoder.set_depth(png::BitDepth::Eight);
                    let mut writer = encoder.write_header()?;
                    let bytes: Vec<_> = image.pixels.iter().flat_map(|p| p.to_array()).collect();
                    writer.write_image_data(&bytes)?;
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("Screenshot failed: {error}");
                    std::process::exit(1);
                }
                println!("Native render proof: {}", self.diagnostics());
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        }
        if self.now_ms > 15_000 {
            eprintln!("Native render proof timed out");
            std::process::exit(1);
        }
    }
}
