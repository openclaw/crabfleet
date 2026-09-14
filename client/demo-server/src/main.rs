use crabfleet_demo_server::serve;
use std::{
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().len() != 1 {
        println!(
            "crabfleet-demo-server\n\nServes synthetic pixels only at ws://127.0.0.1:9001/demo.\nNo host desktop capture, credentials, or operating-system input."
        );
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:9001")?;
    println!("Synthetic desktop listening on ws://127.0.0.1:9001/demo (maximum 4 viewers)");
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let stream = stream?;
        if active.load(Ordering::Relaxed) >= 4 {
            drop(stream);
            continue;
        }
        active.fetch_add(1, Ordering::Relaxed);
        let active = active.clone();
        thread::spawn(move || {
            let _ = serve(stream);
            active.fetch_sub(1, Ordering::Relaxed);
        });
    }
    Ok(())
}
