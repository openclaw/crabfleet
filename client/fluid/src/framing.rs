use prost::Message;
use std::fmt;

pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_BUFFER_BYTES: usize = MAX_MESSAGE_BYTES + 5;

pub trait BoundedMessage: Message + Default {
    fn validate_payload(bytes: &[u8]) -> Result<(), WireError>;
}

pub fn decode<M: BoundedMessage>(bytes: &[u8]) -> Result<M, WireError> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(WireError::Oversized);
    }
    M::validate_payload(bytes)?;
    M::decode(bytes).map_err(|_| WireError::InvalidMessage)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    Oversized,
    InvalidLength,
    InvalidMessage,
    Truncated,
    Closed,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Oversized => "Fluid control message exceeds the client limit",
            Self::InvalidLength => "Invalid Fluid message length",
            Self::InvalidMessage => "Malformed Fluid control message",
            Self::Truncated => "Fluid stream ended in a partial message",
            Self::Closed => "Fluid message decoder is closed",
        })
    }
}
impl std::error::Error for WireError {}

/// The protobuf length prefix can be split across arbitrary transport chunks.
/// Call `next_message` with a per-tick work budget; this decoder never builds an unbounded batch.
#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
    head: usize,
    failed: bool,
}

impl Decoder {
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len() - self.head
    }

    fn fail<T>(&mut self, error: WireError) -> Result<T, WireError> {
        self.buffer.clear();
        self.head = 0;
        self.failed = true;
        Err(error)
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), WireError> {
        if self.failed {
            return Err(WireError::Closed);
        }
        if bytes.len() > MAX_BUFFER_BYTES.saturating_sub(self.buffered_bytes()) {
            return self.fail(WireError::Oversized);
        }
        if self.head > 0 {
            self.buffer.copy_within(self.head.., 0);
            self.buffer.truncate(self.buffered_bytes());
            self.head = 0;
        }
        self.buffer.extend_from_slice(bytes);
        Ok(())
    }

    pub fn next_message<M: BoundedMessage>(&mut self) -> Result<Option<M>, WireError> {
        if self.failed {
            return Err(WireError::Closed);
        }
        let bytes = &self.buffer[self.head..];
        let mut length = 0u32;
        for (index, &byte) in bytes.iter().take(5).enumerate() {
            if index == 4 && byte > 0x0f {
                return self.fail(WireError::InvalidLength);
            }
            length |= u32::from(byte & 0x7f) << (index * 7);
            if byte & 0x80 != 0 {
                continue;
            }
            if length as usize > MAX_MESSAGE_BYTES {
                return self.fail(WireError::Oversized);
            }
            let header = index + 1;
            let end = header + length as usize;
            if bytes.len() < end {
                return Ok(None);
            }
            let message = match decode::<M>(&bytes[header..end]) {
                Ok(message) => message,
                Err(error) => return self.fail(error),
            };
            self.head += end;
            if self.head == self.buffer.len() {
                self.buffer.clear();
                self.head = 0;
            }
            return Ok(Some(message));
        }
        Ok(None)
    }

    /// Use after draining complete messages when the transport closes.
    pub fn finish(&mut self) -> Result<(), WireError> {
        if self.failed {
            return Err(WireError::Closed);
        }
        if self.buffered_bytes() != 0 {
            return self.fail(WireError::Truncated);
        }
        self.failed = true;
        Ok(())
    }
}

pub fn encode<M: Message>(message: &M) -> Result<Vec<u8>, WireError> {
    if message.encoded_len() > MAX_MESSAGE_BYTES {
        return Err(WireError::Oversized);
    }
    Ok(message.encode_length_delimited_to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{Control, Empty, MediaControl};

    #[test]
    fn every_chunk_boundary_including_multibyte_prefix_is_supported() {
        let message = Control {
            media_control: Some(MediaControl {
                stream_id: Some("v".repeat(300)),
                suspend: Some(false),
            }),
            ..Default::default()
        };
        let wire = encode(&message).unwrap();
        for split in 0..wire.len() {
            let mut decoder = Decoder::default();
            decoder.push(&wire[..split]).unwrap();
            assert!(decoder.next_message::<Control>().unwrap().is_none());
            decoder.push(&wire[split..]).unwrap();
            assert_eq!(
                decoder.next_message::<Control>().unwrap(),
                Some(message.clone())
            );
            assert_eq!(decoder.buffered_bytes(), 0);
            decoder.finish().unwrap();
        }
    }

    #[test]
    fn coalesced_messages_and_partial_tail_keep_their_order() {
        let ping = Control {
            ping: Some(Empty {}),
            ..Default::default()
        };
        let wire = encode(&ping).unwrap();
        let mut decoder = Decoder::default();
        decoder
            .push(&[wire.clone(), wire.clone(), wire[..2].to_vec()].concat())
            .unwrap();
        assert_eq!(
            decoder.next_message::<Control>().unwrap(),
            Some(ping.clone())
        );
        assert_eq!(
            decoder.next_message::<Control>().unwrap(),
            Some(ping.clone())
        );
        assert!(decoder.next_message::<Control>().unwrap().is_none());
        decoder.push(&wire[2..]).unwrap();
        assert_eq!(decoder.next_message::<Control>().unwrap(), Some(ping));
    }

    #[test]
    fn rejects_oversized_overflowing_and_invalid_messages_without_resynchronizing() {
        for (wire, error) in [
            (vec![0xff, 0xff, 0xff, 0xff, 0x10], WireError::InvalidLength),
            (vec![0x80; 5], WireError::InvalidLength),
            (vec![0x81, 0x80, 0x80, 0x01], WireError::Oversized),
            (vec![1, 0], WireError::InvalidMessage),
        ] {
            let mut decoder = Decoder::default();
            decoder.push(&wire).unwrap();
            assert_eq!(decoder.next_message::<Control>(), Err(error));
            assert_eq!(decoder.push(&[0]), Err(WireError::Closed));
            assert_eq!(decoder.buffered_bytes(), 0);
        }
        let mut decoder = Decoder::default();
        assert_eq!(
            decoder.push(&vec![0; MAX_BUFFER_BYTES + 1]),
            Err(WireError::Oversized)
        );
    }

    #[test]
    fn transport_end_reports_partial_prefix_and_partial_payload() {
        for wire in [vec![0x80], vec![2, 42]] {
            let mut decoder = Decoder::default();
            decoder.push(&wire).unwrap();
            assert!(decoder.next_message::<Control>().unwrap().is_none());
            assert_eq!(decoder.finish(), Err(WireError::Truncated));
        }
    }
}
