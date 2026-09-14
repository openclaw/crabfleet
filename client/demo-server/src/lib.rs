use crabfleet_client_core::{CAPABILITIES, MAX_TEXT, Message, demo::Desktop};
use std::{
    io::ErrorKind,
    net::TcpStream,
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    protocol::WebSocketConfig,
};

const SUBPROTOCOL: &str = "crabfleet-demo-v1";

#[expect(
    clippy::result_large_err,
    reason = "Tungstenite fixes the callback response type"
)]
fn handshake(request: &Request, mut response: Response) -> Result<Response, ErrorResponse> {
    let protocol = request
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok());
    let valid_origin = request.headers().get("Origin").is_none_or(|value| {
        // The supplied web app is served on this exact local development origin.
        matches!(
            value.to_str(),
            Ok("http://127.0.0.1:8093" | "http://localhost:8093")
        )
    });
    if request.uri().path_and_query().map(|path| path.as_str()) != Some("/demo")
        || protocol != Some(SUBPROTOCOL)
        || !valid_origin
    {
        return Err(tungstenite::http::Response::builder()
            .status(403)
            .body(Some("Local demo protocol required".into()))
            .unwrap());
    }
    response
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
    Ok(response)
}

fn pending(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(error) if error.kind() == ErrorKind::WouldBlock)
}

/// Serve one synthetic desktop on an already accepted loopback connection.
pub fn serve(stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {
    if !stream.peer_addr()?.ip().is_loopback() {
        return Err("Demo connections must be loopback".into());
    }
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_TEXT + 16))
        .max_frame_size(Some(MAX_TEXT + 16))
        .write_buffer_size(0)
        .max_write_buffer_size(2 * 1024 * 1024);
    let mut socket = tungstenite::accept_hdr_with_config(stream, handshake, Some(config))?;
    let greeting = socket.read()?;
    let tungstenite::Message::Binary(data) = greeting else {
        return Err("Expected demo greeting".into());
    };
    if Message::decode(&data)? != Message::Hello(CAPABILITIES) {
        return Err("Unsupported demo capabilities".into());
    }
    socket.send(tungstenite::Message::Binary(
        Message::Hello(CAPABILITIES).encode()?.into(),
    ))?;
    socket.get_mut().set_nonblocking(true)?;
    let mut desktop = Desktop::default();
    let mut sequence = 0;
    let mut next_frame = Instant::now();
    let mut last_flush = Instant::now();
    loop {
        // Input processing is bounded so a busy peer cannot starve frame production.
        for _ in 0..128 {
            match socket.read() {
                Ok(tungstenite::Message::Binary(data)) => {
                    let Message::Input(input) = Message::decode(&data)? else {
                        return Err("Unexpected demo message".into());
                    };
                    desktop.input(input);
                }
                Ok(tungstenite::Message::Close(_)) => return Ok(()),
                Ok(tungstenite::Message::Text(_)) => return Err("Expected binary input".into()),
                Ok(_) => {}
                Err(error) if pending(&error) => break,
                Err(error) => return Err(error.into()),
            }
        }
        match socket.flush() {
            Ok(()) => {
                last_flush = Instant::now();
                if Instant::now() >= next_frame {
                    let frame = Message::Frame(desktop.frame(sequence)).encode()?;
                    sequence += 1;
                    next_frame = Instant::now() + Duration::from_millis(42);
                    if let Err(error) = socket.send(tungstenite::Message::Binary(frame.into()))
                        && !pending(&error)
                    {
                        return Err(error.into());
                    }
                }
            }
            Err(error) if pending(&error) && last_flush.elapsed() < Duration::from_secs(5) => {}
            Err(error) => return Err(error.into()),
        }
        thread::sleep(Duration::from_millis(3));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::{client::IntoClientRequest, handshake::server::create_response};

    #[test]
    fn handshake_requires_demo_path_subprotocol_and_local_browser_origin() {
        for (path, protocol, origin, allowed) in [
            ("/demo", Some(SUBPROTOCOL), None, true),
            (
                "/demo",
                Some(SUBPROTOCOL),
                Some("http://127.0.0.1:8093"),
                true,
            ),
            (
                "/demo",
                Some(SUBPROTOCOL),
                Some("http://localhost:8093"),
                true,
            ),
            (
                "/demo",
                Some(SUBPROTOCOL),
                Some("https://example.org"),
                false,
            ),
            (
                "/demo",
                Some(SUBPROTOCOL),
                Some("http://localhost:9999"),
                false,
            ),
            ("/demo", None, None, false),
            ("/demo", Some("other"), None, false),
            ("/other", Some(SUBPROTOCOL), None, false),
            ("/demo?anything=1", Some(SUBPROTOCOL), None, false),
        ] {
            let mut request = format!("ws://127.0.0.1:9001{path}")
                .into_client_request()
                .unwrap();
            if let Some(protocol) = protocol {
                request
                    .headers_mut()
                    .insert("Sec-WebSocket-Protocol", protocol.parse().unwrap());
            }
            if let Some(origin) = origin {
                request
                    .headers_mut()
                    .insert("Origin", origin.parse().unwrap());
            }
            let response = create_response(&request).unwrap();
            let result = handshake(&request, response);
            assert_eq!(result.is_ok(), allowed, "{path}, {protocol:?}, {origin:?}");
            if let Ok(response) = result {
                assert_eq!(response.headers()["Sec-WebSocket-Protocol"], SUBPROTOCOL);
            }
        }
    }
}
