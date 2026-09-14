use crate::transport::{Connection, DEFAULT_ENDPOINT};
use crabfleet_client_core::{Input, State, remote_point};
use eframe::egui::{self, Color32, RichText, Vec2};
use std::time::Duration;

const BACKGROUND: Color32 = Color32::from_rgb(13, 20, 25);
const PANEL: Color32 = Color32::from_rgb(20, 30, 36);
const ACCENT: Color32 = Color32::from_rgb(109, 229, 188);
const MUTED: Color32 = Color32::from_rgb(142, 159, 168);

pub struct Viewer {
    endpoint: String,
    connection: Option<Connection>,
    state: State,
    texture: Option<egui::TextureHandle>,
    dimensions: [u16; 2],
    received: u64,
    displayed: u64,
    bytes: u64,
    superseded: u64,
    acks: u32,
    view_only: bool,
    capture: bool,
    discard_input: bool,
    buttons: u8,
    last_remote: Option<[u16; 2]>,
    fullscreen: bool,
    started: f64,
    last_frame: f64,
    sample_time: f64,
    sample_frames: u64,
    sample_bytes: u64,
    fps: f64,
    mbps: f64,
    auto_connect: bool,
    #[cfg(not(target_arch = "wasm32"))]
    screenshot: Option<std::path::PathBuf>,
    #[cfg(not(target_arch = "wasm32"))]
    screenshot_requested: bool,
}

impl Viewer {
    pub fn new(cc: &eframe::CreationContext<'_>, auto_connect: bool) -> Self {
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
            endpoint: DEFAULT_ENDPOINT.into(),
            connection: None,
            state: State::Disconnected,
            texture: None,
            dimensions: [800, 450],
            received: 0,
            displayed: 0,
            bytes: 0,
            superseded: 0,
            acks: 0,
            view_only: false,
            capture: false,
            discard_input: false,
            buttons: 0,
            last_remote: None,
            fullscreen: false,
            started: 0.0,
            last_frame: 0.0,
            sample_time: 0.0,
            sample_frames: 0,
            sample_bytes: 0,
            fps: 0.0,
            mbps: 0.0,
            auto_connect,
            #[cfg(not(target_arch = "wasm32"))]
            screenshot: None,
            #[cfg(not(target_arch = "wasm32"))]
            screenshot_requested: false,
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub fn with_screenshot(mut self, path: Option<std::path::PathBuf>) -> Self {
        self.screenshot = path;
        self
    }

    fn connect(&mut self, ctx: &egui::Context) {
        self.disconnect();
        self.texture = None;
        self.received = 0;
        self.displayed = 0;
        self.bytes = 0;
        self.acks = 0;
        self.superseded = 0;
        self.fps = 0.0;
        self.mbps = 0.0;
        self.sample_frames = 0;
        self.sample_bytes = 0;
        self.started = ctx.input(|input| input.time);
        self.last_frame = self.started;
        self.sample_time = self.started;
        match Connection::open(&self.endpoint, ctx.clone()) {
            Ok(connection) => {
                self.connection = Some(connection);
                self.state = State::Connecting;
            }
            Err(reason) => self.state = State::Failed(reason),
        }
    }
    fn send(&mut self, event: Input) {
        if let Some(connection) = &self.connection
            && let Err(reason) = connection.send(event)
        {
            self.state = State::Failed(reason);
            self.connection = None;
            self.capture = false;
            self.buttons = 0;
        }
    }
    fn release(&mut self) {
        if self.capture || self.buttons != 0 {
            self.send(Input::ReleaseAll);
        }
        self.capture = false;
        self.buttons = 0;
    }
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn release_input(&mut self) {
        self.release();
        self.discard_input = true;
    }
    fn disconnect(&mut self) {
        self.release();
        self.connection = None;
        self.state = State::Disconnected;
        self.last_remote = None;
    }
    fn poll(&mut self, ctx: &egui::Context) {
        let now = ctx.input(|input| input.time);
        if let Some(connection) = &self.connection {
            let snapshot = connection.snapshot();
            self.state = snapshot.state;
            self.received = snapshot.received;
            self.bytes = snapshot.bytes;
            self.superseded = snapshot.superseded;
            if let Some(frame) = snapshot.frame {
                self.dimensions = [frame.width, frame.height];
                self.acks = frame.input_count;
                let pixels = egui::ColorImage::from_rgba_unmultiplied(
                    [frame.width as usize, frame.height as usize],
                    &frame.rgba,
                );
                if let Some(texture) = &mut self.texture {
                    texture.set(pixels, egui::TextureOptions::LINEAR);
                } else {
                    self.texture = Some(ctx.load_texture(
                        "remote-desktop",
                        pixels,
                        egui::TextureOptions::LINEAR,
                    ));
                }
                self.displayed += 1;
                self.last_frame = now;
            }
            if matches!(self.state, State::Failed(_)) || now - self.last_frame > 5.0 {
                if !matches!(self.state, State::Failed(_)) {
                    self.state = State::Failed("No frames received for five seconds".into());
                }
                self.connection = None;
                self.capture = false;
                self.buttons = 0;
            }
        }
        let elapsed = now - self.sample_time;
        if elapsed >= 1.0 {
            self.fps = (self.displayed - self.sample_frames) as f64 / elapsed;
            self.mbps = (self.bytes - self.sample_bytes) as f64 * 8.0 / elapsed / 1_000_000.0;
            self.sample_time = now;
            self.sample_frames = self.displayed;
            self.sample_bytes = self.bytes;
        }
    }
    fn state_label(&self) -> &'static str {
        match self.state {
            State::Disconnected => "Disconnected",
            State::Connecting => "Connecting",
            State::Live => "Live",
            State::Failed(_) => "Connection failed",
        }
    }
    pub fn diagnostics(&self) -> String {
        format!(
            "{{\"state\":\"{}\",\"received\":{},\"displayed\":{},\"acknowledged_inputs\":{},\"input_captured\":{},\"view_only\":{}}}",
            self.state_label(),
            self.received,
            self.displayed,
            self.acks,
            self.capture,
            self.view_only
        )
    }
    fn sidebar(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.add_space(14.0);
        ui.label(
            RichText::new("WORKSPACE")
                .monospace()
                .size(11.0)
                .color(MUTED),
        );
        ui.add_space(8.0);
        ui.label(RichText::new("Local lab").size(24.0));
        ui.label(RichText::new("Your client. Two platforms.").color(MUTED));
        ui.add_space(18.0);
        egui::Frame::new()
            .fill(Color32::from_rgb(30, 49, 51))
            .corner_radius(8)
            .inner_margin(14)
            .show(ui, |ui| {
                ui.label(RichText::new("01 / Test desktop").color(ACCENT).strong());
                ui.label(
                    RichText::new("Synthetic screen + input")
                        .size(13.0)
                        .color(MUTED),
                );
            });
        ui.add_space(18.0);
        ui.label(
            RichText::new("DEMO ENDPOINT")
                .monospace()
                .size(11.0)
                .color(MUTED),
        );
        ui.add_enabled(
            self.connection.is_none(),
            egui::TextEdit::singleline(&mut self.endpoint)
                .desired_width(f32::INFINITY)
                .font(egui::TextStyle::Monospace),
        );
        let connected = self.connection.is_some();
        if ui
            .add_sized(
                [ui.available_width(), 38.0],
                egui::Button::new(if connected {
                    "Disconnect"
                } else {
                    "Connect to demo"
                })
                .fill(if connected {
                    Color32::from_rgb(48, 61, 66)
                } else {
                    Color32::from_rgb(43, 92, 77)
                }),
            )
            .clicked()
        {
            if connected {
                self.disconnect();
            } else {
                self.connect(ctx);
            }
        }
        ui.add_space(14.0);
        if ui.checkbox(&mut self.view_only, "View only").changed() {
            self.release();
        }
        ui.label(
            RichText::new("Click the screen to send input. Esc releases control.")
                .size(13.0)
                .color(MUTED),
        );
        ui.add_space(24.0);
        ui.separator();
        ui.add_space(8.0);
        ui.label(RichText::new("SESSION").monospace().size(11.0).color(MUTED));
        for (label, value) in [
            (
                "Display",
                format!("{} × {}", self.dimensions[0], self.dimensions[1]),
            ),
            ("Presented", format!("{:.0} fps", self.fps)),
            ("Received", format!("{:.1} Mb/s", self.mbps)),
            ("Input ACKs", self.acks.to_string()),
            ("Replaced frames", self.superseded.to_string()),
        ] {
            ui.horizontal(|ui| {
                ui.label(RichText::new(label).size(13.0).color(MUTED));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(RichText::new(value).monospace().size(12.0));
                });
            });
        }
        ui.add_space(24.0);
        ui.separator();
        ui.label(RichText::new("Jump Desktop").size(13.0));
        ui.label(
            RichText::new("Launch without --demo to sign in.")
                .size(12.0)
                .color(MUTED),
        );
    }

    fn viewport(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let available = ui.available_size().max(Vec2::splat(1.0));
        let remote_size = Vec2::new(self.dimensions[0] as f32, self.dimensions[1] as f32);
        let scale = (available.x / remote_size.x).min(available.y / remote_size.y);
        let size = remote_size * scale;
        let (outer, _) = ui.allocate_exact_size(available, egui::Sense::hover());
        let rect = egui::Rect::from_center_size(outer.center(), size);
        ui.painter()
            .rect_filled(outer, 0, Color32::from_rgb(8, 13, 17));
        if let Some(texture) = &self.texture {
            ui.painter().image(
                texture.id(),
                rect,
                egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                Color32::WHITE,
            );
            if !matches!(self.state, State::Live) {
                ui.painter()
                    .rect_filled(rect, 0, Color32::from_black_alpha(170));
                ui.painter().text(
                    rect.center(),
                    egui::Align2::CENTER_CENTER,
                    "Session ended",
                    egui::FontId::proportional(26.0),
                    Color32::WHITE,
                );
            }
        } else {
            ui.painter().text(
                rect.center() - Vec2::new(0.0, 18.0),
                egui::Align2::CENTER_CENTER,
                "A desktop, wherever you are.",
                egui::FontId::proportional(28.0),
                Color32::from_rgb(201, 218, 219),
            );
            ui.painter().text(
                rect.center() + Vec2::new(0.0, 25.0),
                egui::Align2::CENTER_CENTER,
                "Start the local demo server, then connect.",
                egui::FontId::proportional(15.0),
                MUTED,
            );
        }
        ui.painter().rect_stroke(
            rect,
            0,
            egui::Stroke::new(
                1.0,
                if self.capture {
                    ACCENT
                } else {
                    Color32::from_rgb(43, 60, 67)
                },
            ),
            egui::StrokeKind::Inside,
        );
        let response = ui.interact(
            rect,
            ui.id().with("remote-viewport"),
            egui::Sense::click_and_drag(),
        );
        if response.clicked() && !self.view_only && matches!(self.state, State::Live) {
            response.request_focus();
        }
        self.forward_input(ctx, rect);
    }

    fn forward_input(&mut self, ctx: &egui::Context, rect: egui::Rect) {
        if self.view_only || !matches!(self.state, State::Live) {
            self.release();
            return;
        }
        let events = ctx.input(|input| input.events.clone());
        for event in events {
            match event {
                egui::Event::PointerButton {
                    pos,
                    button,
                    pressed,
                    ..
                } => {
                    if pressed && !rect.contains(pos) {
                        self.release();
                        continue;
                    }
                    let bit = match button {
                        egui::PointerButton::Primary => 1,
                        egui::PointerButton::Secondary => 2,
                        egui::PointerButton::Middle => 4,
                        _ => 0,
                    };
                    if bit == 0 {
                        continue;
                    }
                    if pressed {
                        self.capture = true;
                    }
                    if !self.capture {
                        continue;
                    }
                    if pressed {
                        self.buttons |= bit;
                    } else {
                        self.buttons &= !bit;
                    }
                    if let Some([x, y]) = remote_point(
                        [pos.x, pos.y],
                        [rect.min.x, rect.min.y],
                        [rect.width(), rect.height()],
                        self.dimensions,
                    )
                    .or(self.last_remote)
                    {
                        self.last_remote = Some([x, y]);
                        self.send(Input::Pointer {
                            x,
                            y,
                            buttons: self.buttons,
                        });
                    }
                }
                egui::Event::PointerMoved(pos) if self.capture => {
                    if let Some([x, y]) = remote_point(
                        [pos.x, pos.y],
                        [rect.min.x, rect.min.y],
                        [rect.width(), rect.height()],
                        self.dimensions,
                    ) {
                        self.last_remote = Some([x, y]);
                        self.send(Input::Pointer {
                            x,
                            y,
                            buttons: self.buttons,
                        });
                    }
                }
                egui::Event::Key {
                    key: egui::Key::Escape,
                    pressed: true,
                    ..
                }
                | egui::Event::WindowFocused(false)
                | egui::Event::PointerGone => self.release(),
                egui::Event::Key { key, pressed, .. } if self.capture => {
                    if let Some(code) = key_code(key) {
                        self.send(Input::Key {
                            code,
                            down: pressed,
                        });
                    }
                }
                egui::Event::Text(text) | egui::Event::Paste(text) if self.capture => {
                    if text.len() <= crabfleet_client_core::MAX_TEXT {
                        self.send(Input::Text(text));
                    }
                }
                egui::Event::MouseWheel { delta, .. } if self.capture => self.send(Input::Scroll {
                    x: delta.x.clamp(-32767.0, 32767.0) as i16,
                    y: delta.y.clamp(-32767.0, 32767.0) as i16,
                }),
                _ => {}
            }
        }
    }
}

fn key_code(key: egui::Key) -> Option<u16> {
    let name = key.name();
    if name.len() == 1 && name.as_bytes()[0].is_ascii_alphanumeric() {
        return Some(name.as_bytes()[0].to_ascii_uppercase() as u16);
    }
    Some(match key {
        egui::Key::Enter => 13,
        egui::Key::Tab => 9,
        egui::Key::Backspace => 8,
        egui::Key::Space => 32,
        egui::Key::Delete => 127,
        egui::Key::ArrowLeft => 256,
        egui::Key::ArrowRight => 257,
        egui::Key::ArrowUp => 258,
        egui::Key::ArrowDown => 259,
        egui::Key::Home => 260,
        egui::Key::End => 261,
        egui::Key::PageUp => 262,
        egui::Key::PageDown => 263,
        _ => return None,
    })
}

impl eframe::App for Viewer {
    fn raw_input_hook(&mut self, _: &egui::Context, raw: &mut egui::RawInput) {
        if crate::input_lifecycle::prepare(raw, &mut self.discard_input) {
            self.release();
        }
    }
    fn ui(&mut self, ui: &mut egui::Ui, _: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if self.auto_connect {
            self.auto_connect = false;
            self.connect(&ctx);
        }
        self.poll(&ctx);
        egui::Panel::top("header")
            .frame(egui::Frame::new().fill(PANEL).inner_margin(18))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
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
                        ui.label(RichText::new(self.state_label()).color(
                            if matches!(self.state, State::Live) {
                                ACCENT
                            } else {
                                MUTED
                            },
                        ));
                    });
                });
            });
        egui::Panel::bottom("footer")
            .frame(egui::Frame::new().fill(PANEL).inner_margin(10))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(if self.capture {
                            "INPUT ACTIVE  ·  Esc to release"
                        } else {
                            "LOCAL DEMO  ·  Synthetic pixels only"
                        })
                        .monospace()
                        .size(11.0)
                        .color(if self.capture { ACCENT } else { MUTED }),
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
        let compact = ui.available_width() <= 760.0;
        if !compact {
            egui::Panel::left("connections")
                .exact_size(250.0)
                .resizable(false)
                .frame(egui::Frame::new().fill(PANEL).inner_margin(18))
                .show(ui, |ui| {
                    egui::ScrollArea::vertical().show(ui, |ui| self.sidebar(ui, &ctx));
                });
        }
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(BACKGROUND).inner_margin(18))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.heading("Test desktop");
                    ui.label(RichText::new("01").monospace().color(MUTED));
                });
                ui.label(
                    RichText::new("Live frames from your local Rust demo server")
                        .size(13.0)
                        .color(MUTED),
                );
                if compact {
                    ui.horizontal_wrapped(|ui| {
                        if ui
                            .button(if self.connection.is_some() {
                                "Disconnect"
                            } else {
                                "Connect to demo"
                            })
                            .clicked()
                        {
                            if self.connection.is_some() {
                                self.disconnect();
                            } else {
                                self.connect(&ctx);
                            }
                        }
                        if ui.checkbox(&mut self.view_only, "View only").changed() {
                            self.release();
                        }
                        if self.capture && ui.button("Release control").clicked() {
                            self.release();
                        }
                    });
                    ui.label(
                        RichText::new("Click to control · Esc to release")
                            .size(12.0)
                            .color(MUTED),
                    );
                }
                if let State::Failed(reason) = &self.state {
                    ui.colored_label(Color32::from_rgb(242, 168, 132), reason);
                }
                ui.add_space(12.0);
                self.viewport(ui, &ctx);
            });
        if self.connection.is_some() {
            ctx.request_repaint_after(Duration::from_millis(40));
        }
        #[cfg(not(target_arch = "wasm32"))]
        self.capture_proof(&ctx);
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Viewer {
    fn capture_proof(&mut self, ctx: &egui::Context) {
        let Some(path) = &self.screenshot else {
            return;
        };
        if self.displayed >= 5
            && ctx.input(|input| input.time) - self.started >= 2.0
            && !self.screenshot_requested
        {
            self.screenshot_requested = true;
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
        }
        for event in ctx.input(|input| input.events.clone()) {
            if let egui::Event::Screenshot { image, .. } = event {
                let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                    let file = std::fs::File::create(path)?;
                    let mut encoder =
                        png::Encoder::new(file, image.width() as u32, image.height() as u32);
                    encoder.set_color(png::ColorType::Rgba);
                    encoder.set_depth(png::BitDepth::Eight);
                    let mut writer = encoder.write_header()?;
                    let rgba: Vec<u8> = image
                        .pixels
                        .iter()
                        .flat_map(|pixel| pixel.to_array())
                        .collect();
                    writer.write_image_data(&rgba)?;
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
        if ctx.input(|input| input.time) - self.started > 15.0 {
            eprintln!("Native render proof timed out: {}", self.diagnostics());
            std::process::exit(1);
        }
        ctx.request_repaint_after(Duration::from_millis(40));
    }
}
