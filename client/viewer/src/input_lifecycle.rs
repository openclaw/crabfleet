use eframe::egui;

/// Hidden passes retain raw events for the next visible pass. Discard interaction
/// from before focus loss so restoring a tab cannot replay clicks, text or keys.
pub fn prepare(raw: &mut egui::RawInput, discard_next: &mut bool) -> bool {
    let hidden = raw
        .viewports
        .get(&raw.viewport_id)
        .is_some_and(|viewport| viewport.visible() == Some(false));
    let release = std::mem::take(discard_next) || !raw.focused || hidden;
    if release {
        raw.events.retain(|event| {
            !matches!(
                event,
                egui::Event::Key { .. }
                    | egui::Event::Text(_)
                    | egui::Event::Ime(_)
                    | egui::Event::Paste(_)
                    | egui::Event::Copy
                    | egui::Event::Cut
                    | egui::Event::PointerButton { .. }
                    | egui::Event::PointerMoved(_)
                    | egui::Event::MouseMoved(_)
                    | egui::Event::MouseWheel { .. }
                    | egui::Event::Touch { .. }
                    | egui::Event::ModifiersChanged(_)
            )
        });
        raw.events
            .push(egui::Event::ModifiersChanged(egui::Modifiers::NONE));
    }
    release
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returning_to_a_hidden_or_blurred_view_cannot_replay_old_input() {
        for hidden in [true, false] {
            let mut raw = egui::RawInput {
                focused: hidden,
                events: vec![
                    egui::Event::PointerButton {
                        pos: egui::pos2(10.0, 10.0),
                        button: egui::PointerButton::Primary,
                        pressed: true,
                        modifiers: egui::Modifiers::CTRL,
                    },
                    egui::Event::Text("stale text".into()),
                    egui::Event::Paste("stale clipboard".into()),
                    egui::Event::WindowFocused(false),
                ],
                ..Default::default()
            };
            raw.viewports.get_mut(&raw.viewport_id).unwrap().occluded = Some(hidden);
            assert!(prepare(&mut raw, &mut false));
            assert_eq!(
                raw.events,
                [
                    egui::Event::WindowFocused(false),
                    egui::Event::ModifiersChanged(egui::Modifiers::NONE)
                ]
            );
            let fresh = egui::RawInput {
                focused: true,
                events: vec![egui::Event::Text("fresh".into())],
                ..Default::default()
            };
            raw.append(fresh);
            raw.viewports.get_mut(&raw.viewport_id).unwrap().occluded = Some(false);
            assert!(!prepare(&mut raw, &mut false));
            assert!(raw.events.contains(&egui::Event::Text("fresh".into())));
        }
        let mut discard = true;
        let mut raw = egui::RawInput {
            focused: true,
            events: vec![egui::Event::Text("before blur".into())],
            ..Default::default()
        };
        assert!(prepare(&mut raw, &mut discard));
        assert!(!discard);
        assert_eq!(
            raw.events,
            [egui::Event::ModifiersChanged(egui::Modifiers::NONE)]
        );
    }
}
