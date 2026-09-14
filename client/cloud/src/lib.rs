//! Account and authenticated signaling for the independent Jump-compatible viewer.
//! Normal password/MFA sign-in, discovery, and peer signaling have live coverage.

pub mod account;
pub mod auth;
pub mod service;
pub mod socket;

use std::fmt;

pub const AUTH_URL: &str = "https://api.jumpdesktop.com/v1/user/auth";
pub const SIGNAL_URL: &str = "wss://neuron.jumpdesktop.com/v1/ws/neuron";
pub const GATEWAY_AUTH_PATH: &str = "/api/jump/auth";
pub const GATEWAY_SIGNAL_PATH: &str = "/api/jump/signaling";
pub const GATEWAY_PROTOCOL: &str = "crabfleet-jump-signaling-v1";

#[cfg(target_arch = "wasm32")]
fn gateway_url(path: &str, websocket: bool) -> Result<String, Error> {
    let location = web_sys::window()
        .ok_or(Error("Browser window is unavailable"))?
        .location();
    let protocol = location
        .protocol()
        .map_err(|_| Error("Browser origin is unavailable"))?;
    let hostname = location
        .hostname()
        .map_err(|_| Error("Browser origin is unavailable"))?;
    if protocol != "https:"
        && !(protocol == "http:"
            && matches!(hostname.as_str(), "localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err(Error("Use HTTPS or the local Rust web gateway"));
    }
    let host = location
        .host()
        .map_err(|_| Error("Browser origin is unavailable"))?;
    let scheme = match (websocket, protocol.as_str()) {
        (true, "https:") => "wss:",
        (true, _) => "ws:",
        (false, _) => protocol.as_str(),
    };
    Ok(format!("{scheme}//{host}{path}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

pub fn connection_id() -> Result<String, Error> {
    use std::fmt::Write;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error("Secure randomness is unavailable"))?;
    let mut id = String::with_capacity(32);
    for byte in bytes {
        write!(id, "{byte:02x}").expect("Writing to String cannot fail");
    }
    Ok(id)
}
