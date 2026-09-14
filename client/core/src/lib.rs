//! Platform-independent session state and a deliberately separate, synthetic demo protocol.
//! CRD1 is not RFB or Jump Desktop Fluid and must never be sent to either service.

use std::fmt;
pub mod demo;

const MAGIC: &[u8; 4] = b"CRD1";
pub const CAPABILITIES: u8 = 3; // RGBA frames and input acknowledgement.
pub const MAX_WIDTH: u16 = 1920;
pub const MAX_HEIGHT: u16 = 1080;
pub const MAX_MESSAGE: usize = 21 + MAX_WIDTH as usize * MAX_HEIGHT as usize * 4;
pub const MAX_TEXT: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError(pub &'static str);
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ProtocolError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub width: u16,
    pub height: u16,
    pub sequence: u64,
    pub input_count: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    Pointer { x: u16, y: u16, buttons: u8 },
    Key { code: u16, down: bool },
    Text(String),
    Scroll { x: i16, y: i16 },
    ReleaseAll,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    Hello(u8),
    Frame(Frame),
    Input(Input),
}

fn dimensions(width: u16, height: u16) -> Result<usize, ProtocolError> {
    if width == 0 || height == 0 || width > MAX_WIDTH || height > MAX_HEIGHT {
        return Err(ProtocolError(
            "Frame dimensions exceed the supported bounds",
        ));
    }
    Ok(width as usize * height as usize * 4)
}

impl Message {
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let mut out = MAGIC.to_vec();
        match self {
            Self::Hello(caps) => {
                out.extend_from_slice(&[0, *caps]);
            }
            Self::Frame(frame) => {
                if frame.rgba.len() != dimensions(frame.width, frame.height)? {
                    return Err(ProtocolError("Frame pixel length is invalid"));
                }
                out.push(1);
                out.extend_from_slice(&frame.width.to_be_bytes());
                out.extend_from_slice(&frame.height.to_be_bytes());
                out.extend_from_slice(&frame.sequence.to_be_bytes());
                out.extend_from_slice(&frame.input_count.to_be_bytes());
                out.extend_from_slice(&frame.rgba);
            }
            Self::Input(input) => {
                out.push(2);
                match input {
                    Input::Pointer { x, y, buttons } => {
                        if *buttons > 7 {
                            return Err(ProtocolError("Unknown pointer button"));
                        }
                        out.push(0);
                        out.extend_from_slice(&x.to_be_bytes());
                        out.extend_from_slice(&y.to_be_bytes());
                        out.push(*buttons);
                    }
                    Input::Key { code, down } => {
                        out.push(1);
                        out.extend_from_slice(&code.to_be_bytes());
                        out.push(u8::from(*down));
                    }
                    Input::Text(text) => {
                        if text.len() > MAX_TEXT {
                            return Err(ProtocolError("Text input is too long"));
                        }
                        out.push(2);
                        out.extend_from_slice(text.as_bytes());
                    }
                    Input::Scroll { x, y } => {
                        out.push(3);
                        out.extend_from_slice(&x.to_be_bytes());
                        out.extend_from_slice(&y.to_be_bytes());
                    }
                    Input::ReleaseAll => {
                        out.push(4);
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < 5 || bytes.len() > MAX_MESSAGE || &bytes[..4] != MAGIC {
            return Err(ProtocolError("Invalid demo protocol envelope"));
        }
        let payload = &bytes[5..];
        match (bytes[4], payload.len()) {
            (0, 1) if payload[0] == CAPABILITIES => Ok(Self::Hello(payload[0])),
            (1, len) if len >= 16 => {
                let width = u16::from_be_bytes([payload[0], payload[1]]);
                let height = u16::from_be_bytes([payload[2], payload[3]]);
                let size = dimensions(width, height)?;
                if len != size + 16 {
                    return Err(ProtocolError("Frame pixel length is invalid"));
                }
                let sequence = u64::from_be_bytes(payload[4..12].try_into().unwrap());
                let input_count = u32::from_be_bytes(payload[12..16].try_into().unwrap());
                Ok(Self::Frame(Frame {
                    width,
                    height,
                    sequence,
                    input_count,
                    rgba: payload[16..].to_vec(),
                }))
            }
            (2, len) if len >= 1 => {
                let body = &payload[1..];
                let u16_at = |index| u16::from_be_bytes([body[index], body[index + 1]]);
                let input = match (payload[0], body.len()) {
                    (0, 5) if body[4] <= 7 => Input::Pointer {
                        x: u16_at(0),
                        y: u16_at(2),
                        buttons: body[4],
                    },
                    (1, 3) if body[2] <= 1 => Input::Key {
                        code: u16_at(0),
                        down: body[2] == 1,
                    },
                    (2, len) if len <= MAX_TEXT => Input::Text(
                        std::str::from_utf8(body)
                            .map_err(|_| ProtocolError("Text input is not UTF-8"))?
                            .into(),
                    ),
                    (3, 4) => Input::Scroll {
                        x: u16_at(0) as i16,
                        y: u16_at(2) as i16,
                    },
                    (4, 0) => Input::ReleaseAll,
                    _ => return Err(ProtocolError("Invalid input message")),
                };
                Ok(Self::Input(input))
            }
            _ => Err(ProtocolError("Unknown or malformed demo message")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Disconnected,
    Connecting,
    Live,
    Failed(String),
}

pub struct Session {
    pub state: State,
    generation: u64,
    negotiated: bool,
    sequence: Option<u64>,
    pub frames: u64,
    pub bytes: u64,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            state: State::Disconnected,
            generation: 0,
            negotiated: false,
            sequence: None,
            frames: 0,
            bytes: 0,
        }
    }
}

impl Session {
    pub fn begin(&mut self) -> u64 {
        self.disconnect();
        self.state = State::Connecting;
        self.generation
    }
    pub fn disconnect(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.state = State::Disconnected;
        self.negotiated = false;
        self.sequence = None;
        self.frames = 0;
        self.bytes = 0;
    }
    pub fn accept(
        &mut self,
        generation: u64,
        message: Message,
    ) -> Result<Option<Frame>, ProtocolError> {
        if generation != self.generation || !matches!(self.state, State::Connecting | State::Live) {
            return Ok(None);
        }
        match message {
            Message::Hello(CAPABILITIES) if !self.negotiated => {
                self.negotiated = true;
                Ok(None)
            }
            Message::Frame(frame) if self.negotiated => {
                if self
                    .sequence
                    .is_some_and(|previous| frame.sequence <= previous)
                {
                    return Ok(None);
                }
                self.bytes = self.bytes.saturating_add(frame.rgba.len() as u64);
                self.frames = self.frames.saturating_add(1);
                self.sequence = Some(frame.sequence);
                self.state = State::Live;
                Ok(Some(frame))
            }
            _ => {
                self.fail("Peer violated the negotiated demo protocol");
                Err(ProtocolError("Peer violated the negotiated demo protocol"))
            }
        }
    }
    pub fn fail(&mut self, message: &str) {
        self.state = State::Failed(message.into());
        self.negotiated = false;
    }
}

/// Map a point within an aspect-fit viewport to a valid remote pixel.
pub fn remote_point(
    point: [f32; 2],
    origin: [f32; 2],
    size: [f32; 2],
    remote: [u16; 2],
) -> Option<[u16; 2]> {
    if !point
        .into_iter()
        .chain(origin)
        .chain(size)
        .all(f32::is_finite)
        || size[0] <= 0.0
        || size[1] <= 0.0
        || remote.contains(&0)
    {
        return None;
    }
    let x = (point[0] - origin[0]) / size[0];
    let y = (point[1] - origin[1]) / size[1];
    if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return None;
    }
    Some([
        ((x * remote[0] as f32) as u16).min(remote[0] - 1),
        ((y * remote[1] as f32) as u16).min(remote[1] - 1),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(sequence: u64) -> Message {
        Message::Frame(Frame {
            width: 2,
            height: 1,
            sequence,
            input_count: 0,
            rgba: vec![20; 8],
        })
    }
    #[test]
    fn roundtrip_and_network_byte_order() {
        let data = frame(0x0102030405060708).encode().unwrap();
        assert_eq!(&data[9..17], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(Message::decode(&data).unwrap(), frame(0x0102030405060708));
        for input in [
            Input::Text("é🦀".into()),
            Input::Pointer {
                x: 1200,
                y: 34,
                buttons: 3,
            },
            Input::Key {
                code: 13,
                down: true,
            },
            Input::Scroll { x: -4, y: 125 },
            Input::ReleaseAll,
        ] {
            let message = Message::Input(input);
            assert_eq!(
                Message::decode(&message.encode().unwrap()).unwrap(),
                message
            );
        }
    }
    #[test]
    fn rejects_every_truncated_frame_and_trailing_bytes() {
        let data = frame(1).encode().unwrap();
        for length in 0..data.len() {
            assert!(Message::decode(&data[..length]).is_err(), "length {length}");
        }
        let mut extra = data.clone();
        extra.push(0);
        assert!(Message::decode(&extra).is_err());
        let mut oversized = data;
        oversized[5..7].copy_from_slice(&u16::MAX.to_be_bytes());
        assert!(Message::decode(&oversized).is_err());
    }
    #[test]
    fn rejects_bad_flags_utf8_and_oversized_text() {
        for data in [
            b"CRD1\0\x80".as_slice(),
            b"CRD1\x02\x01\0\0\x02",
            b"CRD1\x02\x02\xff",
        ] {
            assert!(Message::decode(data).is_err());
        }
        assert!(
            Message::Input(Input::Text("a".repeat(MAX_TEXT + 1)))
                .encode()
                .is_err()
        );
    }
    #[test]
    fn negotiation_and_disconnect_fence_old_frames() {
        let mut session = Session::default();
        let old = session.begin();
        assert!(session.accept(old, frame(0)).is_err());
        let current = session.begin();
        assert_eq!(
            session.accept(old, Message::Hello(CAPABILITIES)).unwrap(),
            None
        );
        session
            .accept(current, Message::Hello(CAPABILITIES))
            .unwrap();
        assert!(session.accept(current, frame(1)).unwrap().is_some());
        assert!(session.accept(current, frame(1)).unwrap().is_none());
        session.disconnect();
        assert!(session.accept(current, frame(2)).unwrap().is_none());
        assert_eq!(session.state, State::Disconnected);
    }
    #[test]
    fn pointer_mapping_handles_letterbox_edges_and_invalid_geometry() {
        assert_eq!(
            remote_point([150.0, 75.0], [50.0, 25.0], [200.0, 100.0], [800, 400]),
            Some([400, 200])
        );
        assert_eq!(
            remote_point([250.0, 125.0], [50.0, 25.0], [200.0, 100.0], [800, 400]),
            Some([799, 399])
        );
        assert_eq!(
            remote_point([49.0, 75.0], [50.0, 25.0], [200.0, 100.0], [800, 400]),
            None
        );
        assert_eq!(
            remote_point([f32::NAN, 0.0], [0.0, 0.0], [200.0, 100.0], [800, 400]),
            None
        );
    }
}
