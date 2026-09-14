mod app;
mod input_lifecycle;
mod jump_bridge;
mod jump_cursor;
mod jump_input;
mod jump_reconnect;
mod jump_runtime;
mod jump_view;
mod transport;

pub enum Viewer {
    Demo(Box<app::Viewer>),
    Jump(Box<jump_view::JumpViewer>),
}
impl Viewer {
    pub fn new(cc: &eframe::CreationContext<'_>, demo: bool) -> Self {
        // The surrounding panels use fixed dark colors on both platforms.
        cc.egui_ctx.set_theme(eframe::egui::Theme::Dark);
        if demo {
            Self::Demo(Box::new(app::Viewer::new(cc, true)))
        } else {
            Self::Jump(Box::new(jump_view::JumpViewer::new(cc)))
        }
    }
    pub fn diagnostics(&self) -> String {
        match self {
            Self::Demo(v) => v.diagnostics(),
            Self::Jump(v) => v.diagnostics(),
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub fn with_screenshot(self, path: Option<std::path::PathBuf>) -> Self {
        match self {
            Self::Demo(v) => Self::Demo(Box::new(v.with_screenshot(path))),
            Self::Jump(mut v) => {
                v.screenshot = path;
                Self::Jump(v)
            }
        }
    }
}
impl eframe::App for Viewer {
    fn raw_input_hook(&mut self, ctx: &eframe::egui::Context, raw: &mut eframe::egui::RawInput) {
        match self {
            Self::Demo(v) => v.raw_input_hook(ctx, raw),
            Self::Jump(v) => v.raw_input_hook(ctx, raw),
        }
    }
    fn logic(&mut self, ctx: &eframe::egui::Context, frame: &mut eframe::Frame) {
        match self {
            Self::Demo(v) => v.logic(ctx, frame),
            Self::Jump(v) => v.logic(ctx, frame),
        }
    }
    #[cfg(target_arch = "wasm32")]
    fn as_any_mut(&mut self) -> Option<&mut dyn std::any::Any> {
        Some(self)
    }
    fn ui(&mut self, ui: &mut eframe::egui::Ui, frame: &mut eframe::Frame) {
        match self {
            Self::Demo(v) => v.ui(ui, frame),
            Self::Jump(v) => v.ui(ui, frame),
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod web {
    use super::*;
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    pub struct WebHandle {
        runner: eframe::WebRunner,
    }
    #[wasm_bindgen]
    impl WebHandle {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                runner: eframe::WebRunner::new(),
            }
        }
        pub async fn start(
            &self,
            canvas: web_sys::HtmlCanvasElement,
            demo: bool,
        ) -> Result<(), JsValue> {
            self.runner
                .start(
                    canvas,
                    eframe::WebOptions::default(),
                    Box::new(move |cc| Ok(Box::new(Viewer::new(cc, demo)))),
                )
                .await
        }
        pub fn diagnostics(&self) -> String {
            self.runner
                .app_mut::<Viewer>()
                .map(|viewer| viewer.diagnostics())
                .unwrap_or_else(|| "{}".into())
        }
        pub fn destroy(&self) {
            self.runner.destroy();
        }
        pub fn release_input(&self) {
            if let Some(mut viewer) = self.runner.app_mut::<Viewer>() {
                match &mut *viewer {
                    Viewer::Demo(v) => v.release_input(),
                    Viewer::Jump(v) => v.release_input(),
                }
            }
        }
    }
    impl Default for WebHandle {
        fn default() -> Self {
            Self::new()
        }
    }
}
