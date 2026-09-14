use crate::control::Empty;
use prost::Message;
use std::fmt;

#[derive(Clone, PartialEq, Message)]
pub struct ClientMessage {
    #[prost(message, optional, tag = "1")]
    pub connect: Option<Connect>,
    #[prost(message, optional, tag = "2")]
    pub send: Option<Send>,
    #[prost(message, optional, tag = "3")]
    pub ping: Option<Empty>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct Connect {
    #[prost(string, optional, tag = "1")]
    pub version: Option<String>,
    #[prost(string, repeated, tag = "2")]
    pub tokens: Vec<String>,
    #[prost(bytes = "vec", optional, tag = "3")]
    pub presence: Option<Vec<u8>>,
    #[prost(bool, optional, tag = "4")]
    pub allow_direct_sends_from_everyone: Option<bool>,
}
impl fmt::Debug for Connect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Connect")
            .field("token_count", &self.tokens.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct Send {
    #[prost(string, optional, tag = "1")]
    pub to_id: Option<String>,
    #[prost(bytes = "vec", optional, tag = "2")]
    pub data: Option<Vec<u8>>,
    #[prost(bool, optional, tag = "3")]
    pub send_peer_info: Option<bool>,
}
impl fmt::Debug for Send {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Send([redacted])")
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct ServerMessage {
    #[prost(message, optional, tag = "1")]
    pub presence: Option<Presence>,
    #[prost(message, optional, tag = "2")]
    pub close: Option<Close>,
    #[prost(message, optional, tag = "3")]
    pub connected: Option<Connected>,
    #[prost(message, optional, tag = "4")]
    pub incoming: Option<Incoming>,
    #[prost(message, optional, tag = "5")]
    pub ping: Option<Empty>,
    #[prost(message, optional, tag = "6")]
    pub tokens: Option<Tokens>,
    #[prost(message, optional, tag = "7")]
    pub ice_servers: Option<IceServers>,
    #[prost(message, optional, tag = "11")]
    pub all_offline: Option<Empty>,
}

#[derive(Clone, PartialEq, Message)]
pub struct Presence {
    #[prost(string, optional, tag = "1")]
    pub id: Option<String>,
    #[prost(bool, optional, tag = "2")]
    pub online: Option<bool>,
    #[prost(bytes = "vec", optional, tag = "3")]
    pub info: Option<Vec<u8>>,
}

#[derive(Clone, PartialEq, Message)]
pub struct Close {
    #[prost(int32, optional, tag = "1")]
    pub reason: Option<i32>,
    #[prost(string, optional, tag = "2")]
    pub message: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
pub struct Connected {
    #[prost(message, optional, tag = "1")]
    pub ice_servers: Option<IceServers>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct Incoming {
    #[prost(string, optional, tag = "1")]
    pub from_id: Option<String>,
    #[prost(bytes = "vec", optional, tag = "2")]
    pub data: Option<Vec<u8>>,
    #[prost(bool, optional, tag = "4")]
    pub peer_unauthorized_to_send: Option<bool>,
}
impl fmt::Debug for Incoming {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Incoming([redacted])")
    }
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct Tokens {
    #[prost(string, repeated, tag = "1")]
    pub tokens: Vec<String>,
}
impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tokens")
            .field("count", &self.tokens.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct IceServers {
    #[prost(message, repeated, tag = "1")]
    pub servers: Vec<IceServer>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct IceServer {
    #[prost(string, optional, tag = "1")]
    pub uri: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub username: Option<String>,
    #[prost(string, optional, tag = "3")]
    pub password: Option<String>,
}
impl fmt::Debug for IceServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IceServer([redacted])")
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct JumpMessage {
    #[prost(message, optional, tag = "1")]
    pub signal: Option<PeerSignal>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct PeerSignal {
    #[prost(string, optional, tag = "1")]
    pub connection_id: Option<String>,
    #[prost(bytes = "vec", optional, tag = "2")]
    pub payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = "3")]
    pub pre_connect_authcode: Option<String>,
}
impl fmt::Debug for PeerSignal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PeerSignal([redacted])")
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct PeerMessage {
    #[prost(message, optional, tag = "1")]
    pub sdp: Option<SessionDescription>,
    #[prost(message, optional, tag = "2")]
    pub candidate: Option<IceCandidate>,
    #[prost(message, optional, tag = "3")]
    pub close: Option<PeerClose>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct SessionDescription {
    #[prost(string, optional, tag = "1")]
    pub sdp_type: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub sdp: Option<String>,
    #[prost(bool, optional, tag = "3")]
    pub unified_plan: Option<bool>,
}
impl fmt::Debug for SessionDescription {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionDescription")
            .field("sdp_type", &self.sdp_type)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct IceCandidate {
    #[prost(string, optional, tag = "1")]
    pub candidate: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub sdp_mid: Option<String>,
    #[prost(int32, optional, tag = "3")]
    pub sdp_m_line_index: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PeerClose {
    #[prost(int32, optional, tag = "1")]
    pub reason: Option<i32>,
}

/// Route only signals belonging to the selected peer and the current connection.
pub fn route(
    incoming: Incoming,
    peer_id: &str,
    connection_id: &str,
) -> Result<Option<PeerMessage>, crate::framing::WireError> {
    use crate::framing::{self, Decoder, WireError};
    if peer_id.is_empty() || connection_id.is_empty() {
        return Err(WireError::InvalidMessage);
    }
    if incoming.from_id.as_deref() != Some(peer_id)
        || incoming.peer_unauthorized_to_send == Some(true)
    {
        return Ok(None);
    }
    let data = incoming.data.as_deref().ok_or(WireError::InvalidMessage)?;
    let jump = framing::decode::<JumpMessage>(data)?;
    let Some(signal) = jump.signal else {
        return Ok(None);
    };
    if signal.connection_id.as_deref() != Some(connection_id) {
        return Ok(None);
    }
    let payload = signal.payload.as_deref().ok_or(WireError::InvalidMessage)?;
    let mut decoder = Decoder::default();
    decoder.push(payload)?;
    let message = decoder
        .next_message::<PeerMessage>()?
        .ok_or(WireError::Truncated)?;
    if decoder.buffered_bytes() != 0 {
        return Err(WireError::InvalidMessage);
    }
    if let Some(sdp) = &message.sdp
        && (!matches!(sdp.sdp_type.as_deref(), Some("offer" | "answer"))
            || sdp.sdp.as_ref().is_none_or(|sdp| sdp.len() > 256 * 1024))
    {
        return Err(WireError::InvalidMessage);
    }
    if let Some(candidate) = &message.candidate
        && (candidate
            .candidate
            .as_ref()
            .is_none_or(|value| value.len() > 32 * 1024)
            || candidate
                .sdp_mid
                .as_ref()
                .is_some_and(|value| value.len() > 1024)
            || candidate
                .sdp_m_line_index
                .is_some_and(|value| !(0..=65535).contains(&value)))
    {
        return Err(WireError::InvalidMessage);
    }
    Ok(Some(message))
}

pub fn signal(
    peer_id: &str,
    connection_id: &str,
    message: &PeerMessage,
    pre_connect_authcode: Option<String>,
    first: bool,
) -> Result<ClientMessage, crate::framing::WireError> {
    use crate::framing::{self, WireError};
    if peer_id.is_empty()
        || peer_id.len() > 1024
        || connection_id.is_empty()
        || connection_id.len() > 256
        || pre_connect_authcode
            .as_ref()
            .is_some_and(|code| code.len() > 16 * 1024)
    {
        return Err(WireError::InvalidMessage);
    }
    let jump = JumpMessage {
        signal: Some(PeerSignal {
            connection_id: Some(connection_id.into()),
            payload: Some(framing::encode(message)?),
            pre_connect_authcode,
        }),
    };
    Ok(ClientMessage {
        send: Some(Send {
            to_id: Some(peer_id.into()),
            data: Some(jump.encode_to_vec()),
            send_peer_info: Some(first),
        }),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing;

    #[test]
    fn nested_signal_uses_delimited_peer_and_undelimited_jump_message() {
        let peer = PeerMessage {
            close: Some(PeerClose { reason: Some(0) }),
            ..Default::default()
        };
        let peer_bytes = framing::encode(&peer).unwrap();
        assert_eq!(peer_bytes, [4, 26, 2, 8, 0]);
        let jump = JumpMessage {
            signal: Some(PeerSignal {
                connection_id: Some("test-session".into()),
                payload: Some(peer_bytes),
                pre_connect_authcode: None,
            }),
        };
        let outer = ClientMessage {
            send: Some(Send {
                to_id: Some("test-peer".into()),
                data: Some(jump.encode_to_vec()),
                send_peer_info: Some(true),
            }),
            ..Default::default()
        };
        let decoded =
            ClientMessage::decode_length_delimited(framing::encode(&outer).unwrap().as_slice())
                .unwrap();
        let jump = JumpMessage::decode(decoded.send.unwrap().data.unwrap().as_slice()).unwrap();
        let nested =
            PeerMessage::decode_length_delimited(jump.signal.unwrap().payload.unwrap().as_slice())
                .unwrap();
        assert_eq!(nested, peer);
    }

    #[test]
    fn token_lists_and_ice_passwords_are_redacted() {
        let connect = ClientMessage {
            connect: Some(Connect {
                tokens: vec!["synthetic-token".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let server = ServerMessage {
            tokens: Some(Tokens {
                tokens: vec!["synthetic-token".into()],
            }),
            ice_servers: Some(IceServers {
                servers: vec![IceServer {
                    uri: Some("turn:localhost".into()),
                    username: Some("synthetic-user".into()),
                    password: Some("synthetic-pass".into()),
                }],
            }),
            ..Default::default()
        };
        assert!(!format!("{connect:?} {server:?}").contains("synthetic"));
    }

    #[test]
    fn routed_signals_are_bound_to_the_authorized_peer_and_current_session() {
        let message = PeerMessage {
            close: Some(PeerClose { reason: Some(0) }),
            ..Default::default()
        };
        let output = signal("test-peer", "test-session", &message, None, true).unwrap();
        let incoming = Incoming {
            from_id: Some("test-peer".into()),
            data: output.send.unwrap().data,
            peer_unauthorized_to_send: Some(false),
        };
        assert_eq!(
            route(incoming.clone(), "test-peer", "test-session").unwrap(),
            Some(message)
        );
        assert!(
            route(incoming.clone(), "other-peer", "test-session")
                .unwrap()
                .is_none()
        );
        assert!(
            route(incoming.clone(), "test-peer", "old-session")
                .unwrap()
                .is_none()
        );
        assert!(
            route(
                Incoming {
                    peer_unauthorized_to_send: Some(true),
                    ..incoming
                },
                "test-peer",
                "test-session"
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn signal_payloads_reject_trailing_frames_and_bad_candidate_indices() {
        let bad = PeerMessage {
            candidate: Some(IceCandidate {
                candidate: Some("candidate:synthetic".into()),
                sdp_mid: Some("0".into()),
                sdp_m_line_index: Some(-1),
            }),
            ..Default::default()
        };
        let output = signal("test-peer", "test-session", &bad, None, false).unwrap();
        let incoming = Incoming {
            from_id: Some("test-peer".into()),
            data: output.send.unwrap().data,
            ..Default::default()
        };
        assert_eq!(
            route(incoming, "test-peer", "test-session"),
            Err(framing::WireError::InvalidMessage)
        );
        let jump = JumpMessage {
            signal: Some(PeerSignal {
                connection_id: Some("test-session".into()),
                payload: Some(vec![0, 0]),
                ..Default::default()
            }),
        };
        let incoming = Incoming {
            from_id: Some("test-peer".into()),
            data: Some(jump.encode_to_vec()),
            ..Default::default()
        };
        assert_eq!(
            route(incoming, "test-peer", "test-session"),
            Err(framing::WireError::InvalidMessage)
        );
    }
}
