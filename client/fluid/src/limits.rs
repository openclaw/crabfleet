//! Preflight the known message tree before prost allocates repeated message objects.
use crate::{
    control::Control,
    discovery,
    framing::{BoundedMessage, WireError},
    signaling,
};

#[derive(Clone, Copy)]
enum Node {
    Plain,
    Control,
    Auth,
    DesktopClient,
    DesktopServer,
    PointerUpdate,
    PointerChanged,
    PointerImage,
    PointerBitmap,
    PeerInfo,
    Input,
    Mouse,
    Clipboard,
    ClipboardAvailable,
    DisplayConfig,
    Display,
    Client,
    Connect,
    Server,
    Connected,
    IceServers,
    Tokens,
    Jump,
    Peer,
    Announcement,
    ServerList,
    ServerInfo,
}

impl Node {
    fn child(self, field: u32) -> Option<Self> {
        use Node::*;
        match (self, field) {
            (Control, 1) => Some(Auth),
            (Control, 2) => Some(DesktopClient),
            (Control, 6) => Some(DesktopServer),
            (Control, 7) => Some(PeerInfo),
            (Control, 3 | 4 | 5 | 10 | 11) | (Auth, 1 | 3) => Some(Plain),
            (DesktopClient, 1) => Some(Input),
            (DesktopClient, 2 | 4 | 5) => Some(Plain),
            (DesktopClient, 3) | (DesktopServer, 1) => Some(Clipboard),
            (DesktopServer, 2) => Some(DisplayConfig),
            (DesktopServer, 3) => Some(PointerUpdate),
            (PointerUpdate, 1) => Some(PointerChanged),
            (PointerUpdate, 2) => Some(PointerImage),
            (PointerChanged, 2) | (PointerImage, 2) | (PointerBitmap, 1) => Some(Plain),
            (PointerImage, 3) => Some(PointerBitmap),
            (Input, 1) => Some(Mouse),
            (Input, 2 | 3 | 9) | (Mouse, 24) => Some(Plain),
            (Clipboard, 1) => Some(ClipboardAvailable),
            (Clipboard, 2 | 3) => Some(Plain),
            (DisplayConfig, 2) => Some(Display),
            (Display, 2 | 4 | 5) => Some(Plain),
            (Client, 1) => Some(Connect),
            (Client, 2 | 3) => Some(Plain),
            (Server, 1 | 2 | 4 | 5 | 11) => Some(Plain),
            (Server, 3) => Some(Connected),
            (Server, 6) => Some(Tokens),
            (Server, 7) | (Connected, 1) => Some(IceServers),
            (IceServers, 1) | (Jump, 1) | (Peer, 1..=3) => Some(Plain),
            (Announcement, 2) => Some(ServerList),
            (ServerList, 1) => Some(ServerInfo),
            (ServerInfo, 2 | 7) => Some(Plain),
            _ => None,
        }
    }
    fn repeated_limit(self, field: u32) -> Option<(usize, bool)> {
        use Node::*;
        match (self, field) {
            (PeerInfo, 5) | (ClipboardAvailable, 1) => Some((32, true)),
            (DisplayConfig, 2) | (IceServers, 1) => Some((32, false)),
            (Connect, 2) | (Tokens, 1) => Some((16, false)),
            (ServerList, 1) | (ServerInfo, 2) => Some((32, false)),
            (ServerList, 3) => Some((32, true)),
            _ => None,
        }
    }
}

fn varint(bytes: &[u8], position: &mut usize) -> Result<u64, WireError> {
    let mut value = 0u64;
    for index in 0..10 {
        let byte = *bytes.get(*position).ok_or(WireError::InvalidMessage)?;
        *position += 1;
        if index == 9 && byte > 1 {
            return Err(WireError::InvalidMessage);
        }
        value |= u64::from(byte & 127) << (index * 7);
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err(WireError::InvalidMessage)
}

fn inspect(bytes: &[u8], node: Node, budget: &mut usize, depth: usize) -> Result<(), WireError> {
    if depth > 16 {
        return Err(WireError::Oversized);
    }
    let mut position = 0;
    let mut repetitions = std::collections::BTreeMap::<u32, usize>::new();
    while position < bytes.len() {
        *budget = budget.checked_sub(1).ok_or(WireError::Oversized)?;
        let tag = varint(bytes, &mut position)?;
        let field = tag >> 3;
        if field == 0 || field > 0x1fff_ffff {
            return Err(WireError::InvalidMessage);
        }
        let field = field as u32;
        let wire_type = tag & 7;
        let mut payload = &[][..];
        match wire_type {
            0 => {
                varint(bytes, &mut position)?;
            }
            1 | 5 => {
                let count = if wire_type == 1 { 8 } else { 4 };
                position = position
                    .checked_add(count)
                    .filter(|&end| end <= bytes.len())
                    .ok_or(WireError::InvalidMessage)?;
            }
            2 => {
                let count = usize::try_from(varint(bytes, &mut position)?)
                    .map_err(|_| WireError::InvalidMessage)?;
                let end = position
                    .checked_add(count)
                    .filter(|&end| end <= bytes.len())
                    .ok_or(WireError::InvalidMessage)?;
                payload = &bytes[position..end];
                position = end;
                if let Some(child) = node.child(field) {
                    inspect(payload, child, budget, depth + 1)?;
                }
            }
            _ => return Err(WireError::InvalidMessage),
        }
        if let Some((limit, packed)) = node.repeated_limit(field) {
            let repeated = repetitions.entry(field).or_default();
            if packed && wire_type == 2 {
                let mut index = 0;
                while index < payload.len() {
                    varint(payload, &mut index)?;
                    *repeated += 1;
                    if *repeated > limit {
                        return Err(WireError::Oversized);
                    }
                }
            } else {
                *repeated += 1;
            }
            if *repeated > limit {
                return Err(WireError::Oversized);
            }
        }
    }
    Ok(())
}

macro_rules! bounded {
    ($message:ty, $node:ident) => {
        impl BoundedMessage for $message {
            fn validate_payload(bytes: &[u8]) -> Result<(), WireError> {
                inspect(bytes, Node::$node, &mut 4096, 0)
            }
        }
    };
}
bounded!(Control, Control);
bounded!(signaling::ClientMessage, Client);
bounded!(signaling::ServerMessage, Server);
bounded!(signaling::JumpMessage, Jump);
bounded!(signaling::PeerMessage, Peer);
bounded!(discovery::Announcement, Announcement);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{control::*, framing};
    use prost::Message;

    #[test]
    fn repeated_empty_displays_are_rejected_before_object_allocation() {
        let message = Control {
            desktop_server: Some(DesktopServer {
                display_config: Some(DisplayConfig {
                    displays: vec![DisplayInfo::default(); 33],
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            framing::decode::<Control>(&message.encode_to_vec()),
            Err(WireError::Oversized)
        );
    }

    #[test]
    fn packed_and_unpacked_repeated_values_obey_the_same_limit() {
        let mut unpacked = Vec::new();
        for _ in 0..33 {
            unpacked.extend_from_slice(&[40, 1]);
        }
        for body in [unpacked, [&[42, 33][..], &[1; 33]].concat()] {
            let message = [&[58, body.len() as u8][..], &body].concat();
            assert_eq!(
                framing::decode::<Control>(&message),
                Err(WireError::Oversized)
            );
        }
    }

    #[test]
    fn repeated_scalar_duplicates_have_a_work_limit() {
        // An unknown varint field still consumes parser work, even without heap allocations.
        let data = [0x98, 0x06, 0x00].repeat(4097);
        assert_eq!(framing::decode::<Control>(&data), Err(WireError::Oversized));
    }
}
