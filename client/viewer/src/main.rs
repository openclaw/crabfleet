#[cfg(not(target_arch = "wasm32"))]
fn main() -> eframe::Result {
    let mut demo = false;
    let mut screenshot = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--demo" => demo = true,
            "--screenshot" => {
                screenshot = Some(std::path::PathBuf::from(args.next().unwrap_or_else(|| {
                    eprintln!("--screenshot needs a PNG path");
                    std::process::exit(2)
                })));
                demo = true;
            }
            "--screenshot-login" => {
                screenshot = Some(std::path::PathBuf::from(args.next().unwrap_or_else(|| {
                    eprintln!("--screenshot-login needs a PNG path");
                    std::process::exit(2)
                })));
                demo = false;
            }
            "--help" | "-h" => {
                println!(
                    "crabfleet-viewer [--demo] [--screenshot FILE.png | --screenshot-login FILE.png]\n\nIndependent Rust desktop viewer. Defaults to Jump account sign-in.\nJump service compatibility is experimental; full validation remains in progress.\n--demo connects to the local synthetic desktop server.\n--screenshot captures the demo; --screenshot-login captures the signed-out interface."
                );
                return Ok(());
            }
            _ => {
                eprintln!("Unknown option; use --help");
                std::process::exit(2);
            }
        }
    }
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([480.0, 360.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Crabfleet Desktop",
        options,
        Box::new(move |cc| {
            Ok(Box::new(
                crabfleet_viewer::Viewer::new(cc, demo).with_screenshot(screenshot),
            ))
        }),
    )
}

#[cfg(target_arch = "wasm32")]
fn main() {}
