use crate::jump_runtime::Action;
use crabfleet_fluid::control::{InputEvent, KeyInput, MouseInput};
use crabfleet_fluid::session::{MAX_TEXT_BYTES, Shortcut};
use eframe::egui::{self, Key};
use std::collections::BTreeSet;
use zeroize::Zeroize;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Text,
    Physical,
}

pub fn maintain_focus(ui: &mut egui::Ui, captured: bool) {
    let id = ui.id().with("remote-image");
    ui.memory_mut(|memory| {
        if captured {
            memory.set_focus_lock_filter(
                id,
                egui::EventFilter {
                    tab: true,
                    horizontal_arrows: true,
                    vertical_arrows: true,
                    escape: true,
                },
            );
        } else {
            memory.surrender_focus(id);
        }
    });
}

#[derive(Default)]
pub struct Capture {
    pub active: bool,
    pub mode: Mode,
    held: BTreeSet<u32>,
    modifiers: [bool; 4],
    preedit: String,
    pending_shortcut: Option<(Shortcut, u64)>,
    last_text_mode: Option<bool>,
}
pub struct FrameInput<'a> {
    pub events: &'a [egui::Event],
    pub rect: egui::Rect,
    pub size: [u32; 2],
    pub focused: bool,
    pub can_control: bool,
    pub text_supported: bool,
    pub modifiers: egui::Modifiers,
    pub now_ms: u64,
}
#[derive(Default)]
pub struct Batch {
    pub actions: Vec<Action>,
    pub error: Option<&'static str>,
}
impl Batch {
    fn push(&mut self, action: Action) {
        // Pointer motion may replace motion, never a button/key transition.
        if is_motion(&action) && self.actions.last().is_some_and(is_motion) {
            *self.actions.last_mut().unwrap() = action;
        } else {
            self.actions.push(action);
        }
    }
}
fn is_motion(action: &Action) -> bool {
    matches!(action, Action::Input(i) if i.mouse.as_ref().is_some_and(|m| m.button.is_none() && m.wheel_delta_x.is_none() && m.wheel_delta_y.is_none()))
}
impl Capture {
    pub fn preedit(&self) -> &str {
        &self.preedit
    }
    pub fn reset(&mut self) {
        self.active = false;
        self.clear_held();
        self.pending_shortcut = None;
    }
    fn clear_held(&mut self) {
        self.held.clear();
        self.modifiers = [false; 4];
        self.preedit.zeroize();
    }
    pub fn release(&mut self) -> bool {
        let active = self.active;
        self.reset();
        active
    }
    fn release_into(&mut self, output: &mut Batch) {
        if self.release() {
            output.push(Action::Release);
        }
    }
    fn sync_modifiers(&mut self, mods: egui::Modifiers, output: &mut Batch) {
        let next = [mods.ctrl, mods.shift, mods.alt, mods.mac_cmd];
        for (index, pressed) in next.into_iter().enumerate() {
            if self.modifiers[index] != pressed {
                output.push(Action::Input(key(0x700e0 + index as u32, pressed)));
            }
        }
        self.modifiers = next;
    }
    fn commit(&mut self, text: &str, output: &mut Batch) {
        if text.is_empty() {
            return;
        }
        if text.len() > MAX_TEXT_BYTES {
            output.error = Some("Committed text exceeds 16 KiB");
            return;
        }
        self.clear_held();
        output.push(Action::Release);
        output.push(Action::CommitText(zeroize::Zeroizing::new(text.to_owned())));
    }
    fn shortcut(&mut self, shortcut: Shortcut, output: &mut Batch) {
        self.clear_held();
        output.push(Action::Release);
        output.push(Action::Shortcut(shortcut));
    }
    pub fn process(&mut self, input: FrameInput<'_>) -> Batch {
        let mut output = Batch::default();
        if !input.focused || !input.can_control {
            self.release_into(&mut output);
            return output;
        }
        if input.events.len() > 2048 {
            self.release_into(&mut output);
            output.error = Some("Too many input events; click the picture to resume");
            return output;
        }
        let text_mode = self.mode == Mode::Text && input.text_supported;
        if self.last_text_mode.is_some_and(|old| old != text_mode) {
            self.release_into(&mut output);
        }
        self.last_text_mode = Some(text_mode);
        let has_text = input.events.iter().any(|e| {
            matches!(
                e,
                egui::Event::Text(_) | egui::Event::Ime(egui::ImeEvent::Commit(_))
            )
        });
        let has_ime = input
            .events
            .iter()
            .any(|e| matches!(e, egui::Event::Ime(_)));
        let has_composition = input.events.iter().any(|e| {
            matches!(
                e,
                egui::Event::Ime(egui::ImeEvent::Preedit { .. } | egui::ImeEvent::Commit(_))
            )
        });
        let has_copy = input.events.iter().any(|e| matches!(e, egui::Event::Copy));
        let has_cut = input.events.iter().any(|e| matches!(e, egui::Event::Cut));
        if self
            .pending_shortcut
            .is_some_and(|(_, deadline)| input.now_ms > deadline)
        {
            self.pending_shortcut = None;
        }
        for event in input.events {
            match event {
                egui::Event::Key {
                    key: Key::Escape,
                    pressed: true,
                    ..
                }
                | egui::Event::WindowFocused(false)
                | egui::Event::PointerGone => self.release_into(&mut output),
                egui::Event::PointerButton {
                    pos,
                    button,
                    pressed,
                    modifiers,
                } => {
                    let Some(point) = point(*pos, input.rect, input.size) else {
                        self.release_into(&mut output);
                        continue;
                    };
                    if !matches!(
                        button,
                        egui::PointerButton::Primary
                            | egui::PointerButton::Middle
                            | egui::PointerButton::Secondary
                    ) {
                        continue;
                    }
                    if *pressed {
                        self.active = true;
                    }
                    if self.active {
                        self.sync_modifiers(*modifiers, &mut output);
                        output.push(Action::Input(mouse(point, Some((*button, *pressed)))));
                    }
                }
                egui::Event::PointerMoved(pos) if self.active => {
                    if let Some(point) = point(*pos, input.rect, input.size) {
                        output.push(Action::Input(mouse(point, None)));
                    } else {
                        self.release_into(&mut output);
                    }
                }
                egui::Event::Key {
                    key: logical,
                    physical_key,
                    pressed,
                    repeat,
                    modifiers,
                } if self.active => {
                    let mapped = if text_mode {
                        *logical
                    } else {
                        physical_key.unwrap_or(*logical)
                    };
                    let Some(code) = usb(mapped) else {
                        continue;
                    };
                    if !*pressed {
                        if self.held.remove(&code) {
                            output.push(Action::Input(key(code, false)));
                        }
                        continue;
                    }
                    if !self.preedit.is_empty() || text_mode && has_ime {
                        continue;
                    }
                    let shortcut_mod = (modifiers.ctrl || modifiers.mac_cmd) && !modifiers.alt;
                    if shortcut_mod {
                        let shortcut = match logical {
                            Key::C => Some(Shortcut::Copy),
                            Key::X => Some(Shortcut::Cut),
                            Key::V => Some(Shortcut::Paste),
                            _ => None,
                        };
                        if let Some(shortcut) = shortcut {
                            if !*repeat
                                && shortcut != Shortcut::Paste
                                && !match shortcut {
                                    Shortcut::Copy => has_copy,
                                    Shortcut::Cut => has_cut,
                                    Shortcut::Paste => true,
                                    _ => false,
                                }
                            {
                                self.shortcut(shortcut, &mut output);
                                self.pending_shortcut =
                                    Some((shortcut, input.now_ms.saturating_add(1000)));
                            }
                            continue;
                        }
                    }
                    let altgr_text =
                        modifiers.ctrl && modifiers.alt && !modifiers.mac_cmd && has_text;
                    let printable = is_printable(code);
                    if text_mode
                        && printable
                        && (!(modifiers.ctrl || modifiers.alt || modifiers.mac_cmd) || altgr_text)
                    {
                        continue;
                    }
                    if !*repeat && self.held.insert(code) {
                        self.sync_modifiers(*modifiers, &mut output);
                        output.push(Action::Input(key(code, true)));
                    }
                }
                egui::Event::Text(text)
                    if self.active && text_mode && self.preedit.is_empty() && !has_composition =>
                {
                    self.commit(text, &mut output)
                }
                egui::Event::Ime(egui::ImeEvent::Preedit { text, .. })
                    if self.active && text_mode =>
                {
                    if text.len() > MAX_TEXT_BYTES {
                        output.error = Some("IME composition exceeds 16 KiB");
                    } else {
                        if self.preedit.is_empty() && !text.is_empty() {
                            output.push(Action::Release);
                            self.clear_held();
                        }
                        self.preedit.zeroize();
                        self.preedit.push_str(text);
                    }
                }
                egui::Event::Ime(egui::ImeEvent::Commit(text)) if self.active && text_mode => {
                    self.preedit.zeroize();
                    self.commit(text, &mut output);
                }
                egui::Event::Ime(egui::ImeEvent::DeleteSurrounding {
                    before_chars,
                    after_chars,
                }) if self.active && text_mode => {
                    if before_chars.saturating_add(*after_chars) > 16 {
                        output.error = Some("IME replacement exceeds 16 characters");
                    } else {
                        output.push(Action::Release);
                        self.clear_held();
                        for (count, code) in [(*before_chars, 0x7002a), (*after_chars, 0x7004c)] {
                            for _ in 0..count {
                                output.push(Action::Input(key(code, true)));
                                output.push(Action::Input(key(code, false)));
                            }
                        }
                    }
                }
                egui::Event::Copy | egui::Event::Cut if self.active => {
                    let shortcut = if matches!(event, egui::Event::Copy) {
                        Shortcut::Copy
                    } else {
                        Shortcut::Cut
                    };
                    if self
                        .pending_shortcut
                        .take()
                        .is_none_or(|(pending, _)| pending != shortcut)
                    {
                        self.shortcut(shortcut, &mut output);
                    }
                }
                egui::Event::Paste(text) if self.active => {
                    if text.len() > 1024 * 1024 {
                        output.error = Some("Clipboard text exceeds 1 MiB");
                    } else {
                        self.clear_held();
                        output.push(Action::Release);
                        output.push(Action::Paste(zeroize::Zeroizing::new(text.clone())));
                    }
                }
                egui::Event::MouseWheel {
                    delta,
                    unit,
                    modifiers,
                    ..
                } if self.active => {
                    self.sync_modifiers(*modifiers, &mut output);
                    let multiplier = match unit {
                        egui::MouseWheelUnit::Point => 1.0,
                        egui::MouseWheelUnit::Line => 40.0,
                        egui::MouseWheelUnit::Page => 800.0,
                    };
                    output.push(Action::Input(InputEvent {
                        mouse: Some(MouseInput {
                            wheel_delta_x: Some((delta.x * multiplier).clamp(-32767.0, 32767.0)),
                            wheel_delta_y: Some((delta.y * multiplier).clamp(-32767.0, 32767.0)),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }));
                }
                _ => {}
            }
            if output.actions.len() > 96 {
                output.error = Some("Input queue is full; click the picture to resume");
            }
            if output.error.is_some() {
                output.actions.clear();
                output.actions.push(Action::Release);
                self.reset();
                return output;
            }
        }
        if self.active {
            if text_mode {
                // Text carries its own case/layout. Release old modifiers without
                // injecting a new Shift/Alt press around committed text.
                let held = self.modifiers;
                self.sync_modifiers(
                    egui::Modifiers {
                        ctrl: input.modifiers.ctrl && held[0],
                        shift: input.modifiers.shift && held[1],
                        alt: input.modifiers.alt && held[2],
                        mac_cmd: input.modifiers.mac_cmd && held[3],
                        command: false,
                    },
                    &mut output,
                );
            } else {
                self.sync_modifiers(input.modifiers, &mut output);
            }
        }
        output
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.preedit.zeroize();
    }
}
fn is_printable(code: u32) -> bool {
    matches!(code & 0xffff, 4..=39 | 44..=56 | 84..=87 | 89..=100 | 103)
}

pub fn key(code: u32, pressed: bool) -> InputEvent {
    InputEvent {
        key: Some(KeyInput {
            usb_keycode: Some(code),
            pressed: Some(pressed),
        }),
        ..Default::default()
    }
}
pub fn mouse(position: [i32; 2], button: Option<(egui::PointerButton, bool)>) -> InputEvent {
    let mapped = button.and_then(|(button, down)| {
        Some((
            match button {
                egui::PointerButton::Primary => 1,
                egui::PointerButton::Middle => 2,
                egui::PointerButton::Secondary => 3,
                _ => return None,
            },
            down,
        ))
    });
    InputEvent {
        mouse: Some(MouseInput {
            x: Some(position[0]),
            y: Some(position[1]),
            button: mapped.map(|b| b.0),
            button_down: mapped.map(|b| b.1),
            ..Default::default()
        }),
        ..Default::default()
    }
}
pub fn point(pos: egui::Pos2, rect: egui::Rect, size: [u32; 2]) -> Option<[i32; 2]> {
    if !pos.is_finite()
        || !rect.is_finite()
        || !rect.contains(pos)
        || rect.width() <= 0.0
        || rect.height() <= 0.0
        || size.contains(&0)
        || size.iter().any(|v| *v > 16384)
    {
        return None;
    }
    Some([
        ((pos.x - rect.left()) / rect.width() * size[0] as f32).clamp(0.0, (size[0] - 1) as f32)
            as i32,
        ((pos.y - rect.top()) / rect.height() * size[1] as f32).clamp(0.0, (size[1] - 1) as f32)
            as i32,
    ])
}
pub fn usb(key: Key) -> Option<u32> {
    let name = key.name();
    let usage = if name.len() == 1 && name.as_bytes()[0].is_ascii_alphabetic() {
        u32::from(name.as_bytes()[0].to_ascii_uppercase() - b'A') + 4
    } else {
        match key {
            Key::Num1 => 30,
            Key::Num2 => 31,
            Key::Num3 => 32,
            Key::Num4 => 33,
            Key::Num5 => 34,
            Key::Num6 => 35,
            Key::Num7 => 36,
            Key::Num8 => 37,
            Key::Num9 => 38,
            Key::Num0 => 39,
            Key::Enter => 40,
            Key::Escape => 41,
            Key::Backspace => 42,
            Key::Tab => 43,
            Key::Space => 44,
            Key::Minus => 45,
            Key::Equals | Key::Plus => 46,
            Key::OpenBracket => 47,
            Key::CloseBracket => 48,
            Key::Backslash => 49,
            Key::Semicolon | Key::Colon => 51,
            Key::Quote => 52,
            Key::Backtick => 53,
            Key::Comma => 54,
            Key::Period => 55,
            Key::Slash | Key::Questionmark => 56,
            Key::F1 => 58,
            Key::F2 => 59,
            Key::F3 => 60,
            Key::F4 => 61,
            Key::F5 => 62,
            Key::F6 => 63,
            Key::F7 => 64,
            Key::F8 => 65,
            Key::F9 => 66,
            Key::F10 => 67,
            Key::F11 => 68,
            Key::F12 => 69,
            Key::Insert => 73,
            Key::Home => 74,
            Key::PageUp => 75,
            Key::Delete => 76,
            Key::End => 77,
            Key::PageDown => 78,
            Key::ArrowRight => 79,
            Key::ArrowLeft => 80,
            Key::ArrowDown => 81,
            Key::ArrowUp => 82,
            _ => return None,
        }
    };
    Some(0x70000 | usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(key: Key, pressed: bool, modifiers: egui::Modifiers) -> egui::Event {
        egui::Event::Key {
            key,
            physical_key: Some(key),
            pressed,
            repeat: false,
            modifiers,
        }
    }
    fn frame(events: &[egui::Event]) -> FrameInput<'_> {
        FrameInput {
            events,
            rect: egui::Rect::from_min_size(egui::pos2(20.0, 40.0), egui::vec2(200.0, 100.0)),
            size: [1000, 500],
            focused: true,
            can_control: true,
            text_supported: true,
            modifiers: egui::Modifiers::NONE,
            now_ms: 10,
        }
    }
    fn active() -> Capture {
        Capture {
            active: true,
            mode: Mode::Text,
            held: BTreeSet::new(),
            modifiers: [false; 4],
            preedit: String::new(),
            pending_shortcut: None,
            last_text_mode: None,
        }
    }
    fn key_events(batch: &Batch) -> Vec<(u32, bool)> {
        batch
            .actions
            .iter()
            .filter_map(|a| {
                if let Action::Input(i) = a {
                    i.key
                        .as_ref()
                        .map(|k| (k.usb_keycode.unwrap(), k.pressed.unwrap()))
                } else {
                    None
                }
            })
            .collect()
    }
    #[test]
    fn local_text_does_not_duplicate_native_or_browser_physical_events() {
        for text_first in [false, true] {
            let mut capture = active();
            let press = event(Key::A, true, egui::Modifiers::SHIFT);
            let text = egui::Event::Text("Ä".into());
            let mut events = if text_first {
                vec![text, press]
            } else {
                vec![press, text]
            };
            events.push(event(Key::A, false, egui::Modifiers::SHIFT));
            let batch = capture.process(frame(&events));
            assert!(key_events(&batch).is_empty());
            let text: Vec<_> = batch
                .actions
                .iter()
                .filter_map(|a| {
                    if let Action::CommitText(t) = a {
                        Some(t.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(text, ["Ä"]);
        }
    }
    #[test]
    fn physical_mode_and_unadvertised_text_capability_keep_hid_input() {
        for advertised in [true, false] {
            let mut capture = active();
            if advertised {
                capture.mode = Mode::Physical;
            }
            let events = [
                event(Key::A, true, egui::Modifiers::NONE),
                egui::Event::Text("a".into()),
                event(Key::A, false, egui::Modifiers::NONE),
            ];
            let mut input = frame(&events);
            input.text_supported = advertised;
            let batch = capture.process(input);
            assert_eq!(key_events(&batch), [(0x70004, true), (0x70004, false)]);
            assert!(
                !batch
                    .actions
                    .iter()
                    .any(|a| matches!(a, Action::CommitText(_)))
            );
        }
    }
    #[test]
    fn remapped_keys_follow_logical_text_mode_and_physical_key_mode() {
        let remapped = |logical, physical, pressed| egui::Event::Key {
            key: logical,
            physical_key: Some(physical),
            pressed,
            repeat: false,
            modifiers: egui::Modifiers::NONE,
        };
        let mut capture = active();
        let batch = capture.process(frame(&[
            remapped(Key::A, Key::Escape, true),
            egui::Event::Text("a".into()),
            remapped(Key::A, Key::Escape, false),
        ]));
        assert!(capture.active);
        assert!(
            key_events(&batch).is_empty(),
            "A remapped printable key must not inject physical Escape alongside text"
        );
        assert!(
            batch
                .actions
                .iter()
                .any(|action| matches!(action, Action::CommitText(text) if text.as_str() == "a"))
        );
        let batch = capture.process(frame(&[
            remapped(Key::Enter, Key::Escape, true),
            remapped(Key::Enter, Key::Escape, false),
        ]));
        assert_eq!(key_events(&batch), [(0x70028, true), (0x70028, false)]);
        let mut physical = active();
        physical.mode = Mode::Physical;
        let batch = physical.process(frame(&[
            remapped(Key::A, Key::Z, true),
            remapped(Key::A, Key::Z, false),
        ]));
        assert_eq!(key_events(&batch), [(0x7001d, true), (0x7001d, false)]);
    }
    #[test]
    fn ime_keeps_preedit_local_and_sends_only_the_commit() {
        let mut capture = active();
        let preedit = [egui::Event::Ime(egui::ImeEvent::Preedit {
            text: "にほん".into(),
            active_range_chars: None,
        })];
        let batch = capture.process(frame(&preedit));
        assert!(batch.actions.iter().all(|a| matches!(a, Action::Release)));
        assert_eq!(capture.preedit(), "にほん");
        let commit = [
            event(Key::Enter, true, egui::Modifiers::NONE),
            egui::Event::Ime(egui::ImeEvent::Commit("日本".into())),
        ];
        let batch = capture.process(frame(&commit));
        assert!(key_events(&batch).is_empty());
        assert!(
            batch
                .actions
                .iter()
                .any(|a| matches!(a, Action::CommitText(t) if t.as_str() == "日本"))
        );
        assert!(capture.preedit().is_empty());
    }
    #[test]
    fn focus_loss_permission_loss_and_outside_drag_release_capture() {
        for reason in 0..3 {
            let mut capture = active();
            capture.mode = Mode::Physical;
            capture.process(frame(&[event(Key::A, true, egui::Modifiers::CTRL)]));
            let events = [egui::Event::PointerMoved(egui::pos2(0.0, 0.0))];
            let mut input = frame(&events);
            if reason == 0 {
                input.focused = false;
            }
            if reason == 1 {
                input.can_control = false;
            }
            let batch = capture.process(input);
            assert!(!capture.active);
            assert!(matches!(batch.actions.as_slice(), [Action::Release]));
            let batch = capture.process(frame(&[event(Key::A, false, egui::Modifiers::NONE)]));
            assert!(batch.actions.is_empty());
        }
    }
    #[test]
    fn copy_shortcut_is_not_duplicated_by_browser_clipboard_events() {
        let mut capture = active();
        let batch = capture.process(frame(&[
            event(Key::C, true, egui::Modifiers::CTRL),
            egui::Event::Copy,
        ]));
        assert_eq!(
            batch
                .actions
                .iter()
                .filter(|a| matches!(a, Action::Shortcut(Shortcut::Copy)))
                .count(),
            1
        );
        assert!(key_events(&batch).is_empty());
        let batch = capture.process(frame(&[event(Key::C, true, egui::Modifiers::CTRL)]));
        assert_eq!(
            batch
                .actions
                .iter()
                .filter(|a| matches!(a, Action::Shortcut(Shortcut::Copy)))
                .count(),
            1
        );
        let batch = capture.process(frame(&[egui::Event::Copy]));
        assert!(batch.actions.is_empty());
    }
    #[test]
    fn paste_is_one_operation_and_oversized_text_stops_capture() {
        let mut capture = active();
        let batch = capture.process(frame(&[
            event(Key::V, true, egui::Modifiers::CTRL),
            egui::Event::Paste("synthetic clipboard".into()),
        ]));
        assert!(key_events(&batch).is_empty());
        assert!(matches!(
            batch.actions.as_slice(),
            [Action::Release, Action::Paste(_)]
        ));
        let batch = capture.process(frame(&[egui::Event::Text(
            "🦀".repeat(MAX_TEXT_BYTES / 4 + 1),
        )]));
        assert!(batch.error.is_some());
        assert!(matches!(batch.actions.as_slice(), [Action::Release]));
        assert!(!capture.active);
    }
    #[test]
    fn motion_is_coalesced_but_buttons_and_key_order_are_preserved() {
        let mut capture = active();
        capture.mode = Mode::Physical;
        let mut events: Vec<_> = (0..100)
            .map(|n| egui::Event::PointerMoved(egui::pos2(21.0 + n as f32, 50.0)))
            .collect();
        events.push(event(Key::A, true, egui::Modifiers::NONE));
        events.push(egui::Event::PointerMoved(egui::pos2(150.0, 50.0)));
        let batch = capture.process(frame(&events));
        assert_eq!(batch.actions.len(), 3);
        assert!(is_motion(&batch.actions[0]));
        assert_eq!(key_events(&batch), [(0x70004, true)]);
        assert!(is_motion(&batch.actions[2]));
    }

    #[test]
    fn altgr_text_does_not_inject_control_alt_or_a_physical_letter() {
        let mut capture = active();
        let mods = egui::Modifiers {
            ctrl: true,
            alt: true,
            ..Default::default()
        };
        let events = [
            event(Key::Q, true, mods),
            egui::Event::Text("@".into()),
            event(Key::Q, false, mods),
        ];
        let mut input = frame(&events);
        input.modifiers = mods;
        let batch = capture.process(input);
        assert!(key_events(&batch).is_empty());
        assert!(
            batch
                .actions
                .iter()
                .any(|a| matches!(a, Action::CommitText(t) if t.as_str() == "@"))
        );
    }

    #[test]
    fn browser_ime_replacement_deletes_old_suffix_and_commits_replacement() {
        let mut capture = active();
        let events = [
            egui::Event::Ime(egui::ImeEvent::DeleteSurrounding {
                before_chars: 3,
                after_chars: 0,
            }),
            egui::Event::Text("Texas".into()),
        ];
        let batch = capture.process(frame(&events));
        assert_eq!(
            key_events(&batch),
            [
                (0x7002a, true),
                (0x7002a, false),
                (0x7002a, true),
                (0x7002a, false),
                (0x7002a, true),
                (0x7002a, false)
            ]
        );
        assert!(
            matches!(batch.actions.last(), Some(Action::CommitText(t)) if t.as_str() == "Texas")
        );
    }

    #[test]
    fn capability_change_cancels_composition_and_requires_recapture() {
        let mut capture = active();
        capture.process(frame(&[egui::Event::Ime(egui::ImeEvent::Preedit {
            text: "かな".into(),
            active_range_chars: None,
        })]));
        let events = [egui::Event::Ime(egui::ImeEvent::Commit("仮名".into()))];
        let mut input = frame(&events);
        input.text_supported = false;
        let batch = capture.process(input);
        assert!(matches!(batch.actions.as_slice(), [Action::Release]));
        assert!(!capture.active);
        assert!(capture.preedit().is_empty());
    }

    #[test]
    fn event_bursts_are_rejected_as_a_whole_and_release_previous_input() {
        let mut capture = active();
        capture.mode = Mode::Physical;
        capture.process(frame(&[event(Key::B, true, egui::Modifiers::NONE)]));
        let events: Vec<_> = (0..150)
            .map(|index| event(Key::A, index % 2 == 0, egui::Modifiers::NONE))
            .collect();
        let batch = capture.process(frame(&events));
        assert!(batch.error.is_some());
        assert!(matches!(batch.actions.as_slice(), [Action::Release]));
        assert!(!capture.active);
    }

    #[test]
    fn egui_tab_and_arrow_navigation_stays_remote_until_capture_is_released() {
        let ctx = egui::Context::default();
        let mut remote_id = egui::Id::NULL;
        for tick in 0..5 {
            let events = match tick {
                2 => vec![event(Key::Tab, true, egui::Modifiers::NONE)],
                3 => vec![event(Key::ArrowRight, true, egui::Modifiers::NONE)],
                _ => Vec::new(),
            };
            let raw = egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(
                    egui::Pos2::ZERO,
                    egui::vec2(600.0, 400.0),
                )),
                events,
                ..Default::default()
            };
            let mut output = ctx.run_ui(raw, |ui| {
                remote_id = ui.id().with("remote-image");
                let rect =
                    egui::Rect::from_min_size(egui::pos2(20.0, 80.0), egui::vec2(400.0, 240.0));
                let response = ui.interact(rect, remote_id, egui::Sense::click_and_drag());
                if tick == 0 {
                    response.request_focus();
                }
                let _ = ui.button("Another focus target");
                maintain_focus(ui, tick < 4);
            });
            output.textures_delta.clear();
            if tick < 4 {
                assert_eq!(ctx.memory(|m| m.focused()), Some(remote_id));
            } else {
                assert_ne!(ctx.memory(|m| m.focused()), Some(remote_id));
            }
        }
    }
    #[test]
    fn hid_codes_buttons_and_letterboxed_coordinates() {
        assert_eq!(usb(Key::A), Some(0x70004));
        assert_eq!(usb(Key::ArrowLeft), Some(0x70050));
        assert_eq!(usb(Key::Num0), Some(0x70027));
        assert_eq!(
            mouse([4, 9], Some((egui::PointerButton::Secondary, false)))
                .mouse
                .unwrap()
                .button,
            Some(3)
        );
        let rect = egui::Rect::from_min_size(egui::pos2(20.0, 40.0), egui::vec2(200.0, 100.0));
        assert_eq!(
            point(egui::pos2(120.0, 90.0), rect, [1000, 500]),
            Some([500, 250])
        );
        assert_eq!(point(egui::pos2(0.0, 90.0), rect, [1000, 500]), None);
        assert_eq!(point(egui::pos2(f32::NAN, 90.0), rect, [1000, 500]), None);
    }
}
