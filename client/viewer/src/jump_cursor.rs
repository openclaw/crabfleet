use crabfleet_fluid::cursor::{Image, State};
use eframe::egui;
use std::sync::Arc;

#[derive(Default)]
pub struct Painter {
    image: Option<Arc<Image>>,
    texture: Option<egui::TextureHandle>,
}
impl Painter {
    pub fn sync(&mut self, ctx: &egui::Context, state: &State) {
        let Some(image) = &state.image else {
            *self = Self::default();
            return;
        };
        if self
            .image
            .as_ref()
            .is_some_and(|old| Arc::ptr_eq(old, image))
        {
            return;
        }
        let pixels = egui::ColorImage::from_rgba_unmultiplied(
            [image.size[0] as usize, image.size[1] as usize],
            &image.rgba,
        );
        if let Some(texture) = &mut self.texture {
            texture.set(pixels, egui::TextureOptions::LINEAR);
        } else {
            self.texture =
                Some(ctx.load_texture("jump-cursor", pixels, egui::TextureOptions::LINEAR));
        }
        self.image = Some(image.clone());
    }
    pub fn paint(&self, ui: &egui::Ui, viewport: egui::Rect, visible: bool) {
        if !visible {
            ui.ctx().set_cursor_icon(egui::CursorIcon::None);
            return;
        }
        if let (Some(texture), Some(image), Some(pointer)) = (
            &self.texture,
            &self.image,
            ui.input(|i| i.pointer.hover_pos()),
        ) {
            ui.ctx().set_cursor_icon(egui::CursorIcon::None);
            ui.painter()
                .with_clip_rect(viewport.intersect(ui.clip_rect()))
                .image(
                    texture.id(),
                    image_rect(image, pointer),
                    egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
                    egui::Color32::WHITE,
                );
        } else {
            ui.ctx().set_cursor_icon(egui::CursorIcon::Crosshair);
        }
    }
}
fn image_rect(image: &Image, pointer: egui::Pos2) -> egui::Rect {
    let scale = 100.0 / image.scale_factor100 as f32;
    egui::Rect::from_min_size(
        pointer - egui::vec2(image.hotspot[0] as f32, image.hotspot[1] as f32) * scale,
        egui::vec2(image.size[0] as f32, image.size[1] as f32) * scale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidpi_cursor_keeps_its_hotspot_at_the_input_position() {
        let image = Image {
            size: [64, 48],
            hotspot: [8, 12],
            scale_factor100: 200,
            rgba: vec![],
        };
        let rect = image_rect(&image, egui::pos2(100.0, 75.0));
        assert_eq!(rect.min, egui::pos2(96.0, 69.0));
        assert_eq!(rect.size(), egui::vec2(32.0, 24.0));
        assert_eq!(rect.min + egui::vec2(4.0, 6.0), egui::pos2(100.0, 75.0));
    }
}
