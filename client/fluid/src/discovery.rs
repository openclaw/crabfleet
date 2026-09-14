use crate::{
    framing::{Decoder, WireError},
    signaling::Presence,
};
use prost::Message;
use std::collections::BTreeMap;

const MAX_COMPUTERS: usize = 4096;
const MAX_METADATA_BYTES: usize = 16 * 1024;

/// Projection of the public discovery message; unneeded fields stay opaque.
#[derive(Clone, PartialEq, Message)]
pub struct Announcement {
    #[prost(message, optional, tag = "2")]
    pub server_list: Option<ServerList>,
}
#[derive(Clone, PartialEq, Message)]
pub struct ServerList {
    #[prost(message, repeated, tag = "1")]
    pub servers: Vec<ServerInfo>,
    #[prost(int32, repeated, packed = "false", tag = "3")]
    pub connect_methods: Vec<i32>,
}
#[derive(Clone, PartialEq, Message)]
pub struct ServerInfo {
    #[prost(string, optional, tag = "1")]
    pub tunnel_name: Option<String>,
    #[prost(message, repeated, tag = "2")]
    pub info: Vec<KeyValue>,
    #[prost(int32, optional, tag = "3")]
    pub protocol: Option<i32>,
    #[prost(string, optional, tag = "4")]
    pub name: Option<String>,
    #[prost(int32, optional, tag = "6")]
    pub os_type: Option<i32>,
    #[prost(message, optional, tag = "7")]
    pub os_version: Option<Version>,
}
#[derive(Clone, PartialEq, Message)]
pub struct KeyValue {
    #[prost(string, required, tag = "1")]
    pub key: String,
    #[prost(string, required, tag = "2")]
    pub value: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct Version {
    #[prost(int32, optional, tag = "1")]
    pub major: Option<i32>,
    #[prost(int32, optional, tag = "2")]
    pub minor: Option<i32>,
    #[prost(int32, optional, tag = "3")]
    pub patch: Option<i32>,
    #[prost(int32, optional, tag = "4")]
    pub build: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Computer {
    pub id: String,
    pub name: String,
    pub online: bool,
    pub supports_rtc: bool,
    pub supports_rtc_v2: bool,
    pub os_type: Option<i32>,
    pub os_version: String,
}
impl Computer {
    pub fn can_connect(&self) -> bool {
        self.online && self.supports_rtc && self.supports_rtc_v2
    }
}

/// One account's current server-advertised computer set; clear on account change.
#[derive(Default)]
pub struct Directory {
    computers: BTreeMap<String, Computer>,
}
impl Directory {
    pub fn computers(&self) -> impl Iterator<Item = &Computer> {
        self.computers.values()
    }
    pub fn get(&self, id: &str) -> Option<&Computer> {
        self.computers.get(id)
    }
    pub fn clear(&mut self) {
        self.computers.clear();
    }
    pub fn all_offline(&mut self) {
        for computer in self.computers.values_mut() {
            computer.online = false;
        }
    }

    pub fn presence(&mut self, presence: Presence) -> Result<(), WireError> {
        let id = presence
            .id
            .filter(|id| !id.is_empty() && id.len() <= 1024)
            .ok_or(WireError::InvalidMessage)?;
        let mut computer = self.computers.get(&id).cloned().unwrap_or(Computer {
            id: id.clone(),
            name: String::new(),
            online: false,
            supports_rtc: false,
            supports_rtc_v2: false,
            os_type: None,
            os_version: String::new(),
        });
        if let Some(online) = presence.online {
            computer.online = online;
        }
        if let Some(info) = presence.info
            && !info.is_empty()
        {
            let mut decoder = Decoder::default();
            decoder.push(&info)?;
            let announcement = decoder
                .next_message::<Announcement>()?
                .ok_or(WireError::Truncated)?;
            if decoder.buffered_bytes() != 0 {
                return Err(WireError::InvalidMessage);
            }
            decoder.finish()?;
            if let Some(list) = announcement.server_list {
                let mut total = 0usize;
                for server in &list.servers {
                    total += server.name.as_ref().map_or(0, String::len)
                        + server.tunnel_name.as_ref().map_or(0, String::len);
                    for item in &server.info {
                        total += item.key.len() + item.value.len();
                    }
                    if total > MAX_METADATA_BYTES {
                        return Err(WireError::Oversized);
                    }
                }
                computer.supports_rtc = list.servers.iter().any(|server| {
                    server.protocol == Some(3)
                        || server.protocol.unwrap_or(0) == 0
                            && server.tunnel_name.as_deref() == Some("rtc")
                });
                computer.supports_rtc_v2 = list.connect_methods.contains(&2);
                if let Some(server) = list.servers.first() {
                    computer.name = server
                        .name
                        .as_ref()
                        .filter(|name| !name.is_empty())
                        .cloned()
                        .or_else(|| metadata(server, "name"))
                        .unwrap_or_default();
                    if computer.name.len() > 1024 {
                        return Err(WireError::Oversized);
                    }
                    computer.os_type = server.os_type;
                    computer.os_version = server
                        .os_version
                        .as_ref()
                        .map(|version| {
                            format!(
                                "{}.{}.{}",
                                version.major.unwrap_or(0),
                                version.minor.unwrap_or(0),
                                version.patch.unwrap_or(0)
                            )
                        })
                        .or_else(|| metadata(server, "os-ver"))
                        .unwrap_or_default();
                }
            }
        }
        if !self.computers.contains_key(&id) && self.computers.len() >= MAX_COMPUTERS {
            return Err(WireError::Oversized);
        }
        self.computers.insert(id, computer);
        Ok(())
    }
}

fn metadata(server: &ServerInfo, key: &str) -> Option<String> {
    server
        .info
        .iter()
        .find(|item| item.key == key)
        .map(|item| item.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing;

    fn announcement() -> Announcement {
        Announcement {
            server_list: Some(ServerList {
                servers: vec![ServerInfo {
                    protocol: Some(3),
                    name: Some("Synthetic desktop".into()),
                    ..Default::default()
                }],
                connect_methods: vec![2],
            }),
        }
    }
    #[test]
    fn presence_requires_rtc_capability_and_tracks_offline_updates() {
        let mut directory = Directory::default();
        directory
            .presence(Presence {
                id: Some("test-peer".into()),
                online: Some(true),
                info: Some(framing::encode(&announcement()).unwrap()),
            })
            .unwrap();
        assert!(directory.get("test-peer").unwrap().can_connect());
        directory
            .presence(Presence {
                id: Some("test-peer".into()),
                online: Some(false),
                info: None,
            })
            .unwrap();
        assert!(!directory.get("test-peer").unwrap().can_connect());
        assert_eq!(
            directory.get("test-peer").unwrap().name,
            "Synthetic desktop"
        );
        directory.clear();
        assert_eq!(directory.computers().count(), 0);
    }
    #[test]
    fn malformed_or_trailing_info_cannot_partially_update_directory() {
        let mut directory = Directory::default();
        let mut bytes = framing::encode(&announcement()).unwrap();
        bytes.extend_from_slice(&[0]);
        assert!(
            directory
                .presence(Presence {
                    id: Some("test-peer".into()),
                    online: Some(true),
                    info: Some(bytes)
                })
                .is_err()
        );
        assert_eq!(directory.computers().count(), 0);
    }
    #[test]
    fn repeated_limits_are_per_field_and_apply_before_allocation() {
        let mut message = announcement();
        message.server_list.as_mut().unwrap().servers = vec![ServerInfo::default(); 32];
        message.server_list.as_mut().unwrap().connect_methods = vec![2; 32];
        assert!(framing::decode::<Announcement>(&message.encode_to_vec()).is_ok());
        message
            .server_list
            .as_mut()
            .unwrap()
            .servers
            .push(ServerInfo::default());
        assert_eq!(
            framing::decode::<Announcement>(&message.encode_to_vec()),
            Err(WireError::Oversized)
        );
    }
}
