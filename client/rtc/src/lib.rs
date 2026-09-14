//! WebRTC transport and decoded media for the independent desktop viewer.
//! Signaling delivery and host authentication belong to the calling session.

pub mod connection;
mod inbox;
#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::Peer;
#[cfg(target_arch = "wasm32")]
mod browser;
#[cfg(target_arch = "wasm32")]
pub use browser::Peer;

use std::fmt;

pub const MAX_CONTROL_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SDP_BYTES: usize = 256 * 1024;
pub const MAX_CANDIDATE_BYTES: usize = 32 * 1024;
pub const MAX_VIDEO_PIXELS: usize = 4096 * 4096;
pub const MAX_BUFFERED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SdpKind {
    Offer,
    Answer,
}

#[derive(Clone)]
pub struct Description {
    pub kind: SdpKind,
    pub sdp: String,
}
impl fmt::Debug for Description {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Description")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct Candidate {
    pub candidate: String,
    pub mline_index: u32,
    pub mid: Option<String>,
}
impl fmt::Debug for Candidate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Candidate")
            .field("mline_index", &self.mline_index)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct IceServer {
    pub uri: String,
    pub username: Option<String>,
    pub password: Option<String>,
}
impl fmt::Debug for IceServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IceServer([redacted])")
    }
}

#[derive(Default)]
pub struct Options {
    pub ice_servers: Vec<IceServer>,
    pub audio_enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

pub enum Event {
    Description(Description),
    Candidate(Candidate),
    Connection(ConnectionState),
    ControlOpened,
    ControlData(Vec<u8>),
    ControlClosed,
    AudioPlaybackBlocked,
    NetworkLost,
    Failed(Error),
}
impl fmt::Debug for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Description(d) => d.fmt(f),
            Self::Candidate(c) => c.fmt(f),
            Self::Connection(s) => f.debug_tuple("Connection").field(s).finish(),
            Self::ControlOpened => f.write_str("ControlOpened"),
            Self::ControlClosed => f.write_str("ControlClosed"),
            Self::AudioPlaybackBlocked => f.write_str("AudioPlaybackBlocked"),
            Self::NetworkLost => f.write_str("NetworkLost"),
            Self::ControlData(b) => f
                .debug_struct("ControlData")
                .field("bytes", &b.len())
                .finish(),
            Self::Failed(e) => f.debug_tuple("Failed").field(e).finish(),
        }
    }
}

pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct Updates {
    pub events: Vec<Event>,
    pub frame: Option<VideoFrame>,
    /// Native decoded PCM sample frames, including muted playback; zero in browsers.
    pub audio_samples: u64,
}

fn frame_bytes(width: u32, height: u32) -> Result<usize, Error> {
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or(Error("Video size overflow"))?;
    if width == 0 || height == 0 || width > 8192 || height > 8192 || pixels > MAX_VIDEO_PIXELS {
        return Err(Error("Video dimensions exceed the client limit"));
    }
    pixels.checked_mul(4).ok_or(Error("Video size overflow"))
}

fn validate_candidate(candidate: &Candidate) -> Result<(), Error> {
    if candidate.candidate.len() > MAX_CANDIDATE_BYTES
        || candidate.mline_index > 65535
        || candidate.mid.as_ref().is_some_and(|mid| mid.len() > 1024)
    {
        return Err(Error("ICE candidate exceeds the client limit"));
    }
    Ok(())
}
