use crabfleet_web_gateway::Gateway;
use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut listen: SocketAddr = "127.0.0.1:8093".parse()?;
    let mut origin = None;
    let mut assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => listen = args.next().ok_or("--listen requires an IP:port")?.parse()?,
            "--origin" => {
                origin = Some(
                    args.next()
                        .ok_or("--origin requires an HTTPS or localhost origin")?,
                )
            }
            "--assets" => {
                assets = PathBuf::from(
                    args.next()
                        .ok_or("--assets requires the built web directory")?,
                )
            }
            "--help" | "-h" => {
                println!(
                    "crabfleet-web-gateway [--listen 127.0.0.1:8093] [--origin https://desktop.example] [--assets DIR]\n\nServes the independent WASM viewer and its account/signaling gateway.\nListens only on loopback. Public HTTPS requires your own reverse proxy.\nUpstream service endpoints are fixed. Credentials and payloads are not logged or persisted.\nJump compatibility is experimental; full validation remains in progress."
                );
                return Ok(());
            }
            _ => return Err("Unknown option; use --help".into()),
        }
    }
    if !listen.ip().is_loopback() {
        return Err("The gateway listens only on a loopback address".into());
    }
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let origin = origin
        .unwrap_or_else(|| format!("http://{}", listener.local_addr().expect("Bound listener")));
    let gateway = Gateway::new(&origin, &assets).await?;
    println!("Crabfleet web viewer: {}", gateway.origin());
    let shutdown = gateway.clone();
    axum::serve(listener, gateway.router())
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            shutdown.stop();
        })
        .await?;
    Ok(())
}
