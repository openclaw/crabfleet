use prost::Message;
use std::fmt;

#[derive(Clone, PartialEq, Message)]
pub struct Empty {}

#[derive(Clone, PartialEq, Message)]
pub struct Control {
    #[prost(message, optional, tag = "1")]
    pub auth: Option<HostAuth>,
    #[prost(message, optional, tag = "2")]
    pub desktop_client: Option<DesktopClient>,
    #[prost(message, optional, tag = "3")]
    pub media_control: Option<MediaControl>,
    #[prost(message, optional, tag = "4")]
    pub error: Option<PeerError>,
    #[prost(message, optional, tag = "5")]
    pub ping: Option<Empty>,
    #[prost(message, optional, tag = "6")]
    pub desktop_server: Option<DesktopServer>,
    #[prost(message, optional, tag = "7")]
    pub peer_info: Option<PeerInfo>,
    #[prost(message, optional, tag = "10")]
    pub compression_start: Option<CompressionStart>,
    #[prost(message, optional, tag = "11")]
    pub connection_control: Option<ConnectionControl>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PeerInfo {
    #[prost(int32, optional, tag = "1")]
    pub os_type: Option<i32>,
    #[prost(int32, optional, tag = "2")]
    pub peer_version: Option<i32>,
    #[prost(bool, optional, tag = "3")]
    pub supports_interactive_auth: Option<bool>,
    #[prost(bool, optional, tag = "4")]
    pub supports_local_auth: Option<bool>,
    #[prost(int32, repeated, packed = "false", tag = "5")]
    pub supported_compression_types: Vec<i32>,
    #[prost(bool, optional, tag = "6")]
    pub supports_set_display: Option<bool>,
    #[prost(bool, optional, tag = "7")]
    pub supports_text_inject_up_down: Option<bool>,
    #[prost(bool, optional, tag = "8")]
    pub supports_pointer_position: Option<bool>,
    #[prost(bool, optional, tag = "9")]
    pub supports_target_bitrate: Option<bool>,
    #[prost(bool, optional, tag = "10")]
    pub supports_audio_input: Option<bool>,
    #[prost(uint32, optional, tag = "11")]
    pub virtual_display_count: Option<u32>,
    #[prost(bool, optional, tag = "13")]
    pub supports_anonymous_auth: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
pub struct HostAuth {
    #[prost(message, optional, tag = "1")]
    pub userpass: Option<UsernamePassword>,
    #[prost(message, optional, tag = "3")]
    pub interactive: Option<Empty>,
    #[prost(uint32, optional, tag = "4")]
    pub access_mask_updated: Option<u32>,
    #[prost(bool, optional, tag = "5")]
    pub console_session_only: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct UsernamePassword {
    #[prost(string, optional, tag = "1")]
    pub username: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub password: Option<String>,
}
impl fmt::Debug for UsernamePassword {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("UsernamePassword([redacted])")
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct DesktopClient {
    #[prost(message, optional, tag = "1")]
    pub input: Option<InputEvent>,
    #[prost(message, optional, tag = "2")]
    pub add_media: Option<AddDesktopMedia>,
    #[prost(message, optional, tag = "3")]
    pub clipboard: Option<Clipboard>,
    #[prost(message, optional, tag = "4")]
    pub capture_display: Option<CaptureDisplay>,
    #[prost(message, optional, tag = "5")]
    pub pointer_request: Option<PointerRequest>,
}

#[derive(Clone, PartialEq, Message)]
pub struct DesktopServer {
    #[prost(message, optional, tag = "1")]
    pub clipboard: Option<Clipboard>,
    #[prost(message, optional, tag = "2")]
    pub display_config: Option<DisplayConfig>,
    #[prost(message, optional, tag = "3")]
    pub pointer_update: Option<PointerUpdate>,
}

#[derive(Clone, PartialEq, Message)]
pub struct AddDesktopMedia {
    #[prost(bool, optional, tag = "1")]
    pub suspended: Option<bool>,
    #[prost(bool, optional, tag = "2")]
    pub add_system_audio: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
pub struct CaptureDisplay {
    #[prost(string, optional, tag = "1")]
    pub display_id: Option<String>,
    #[prost(float, optional, tag = "2")]
    pub max_fps: Option<f32>,
    #[prost(bool, optional, tag = "4")]
    pub retina_capture: Option<bool>,
    #[prost(bool, optional, tag = "5")]
    pub full_range_capture: Option<bool>,
    #[prost(int32, optional, tag = "6")]
    pub encoding_format: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct InputEvent {
    #[prost(message, optional, tag = "1")]
    pub mouse: Option<MouseInput>,
    #[prost(message, optional, tag = "2")]
    pub key: Option<KeyInput>,
    #[prost(message, optional, tag = "3")]
    pub text: Option<TextInput>,
    #[prost(message, optional, tag = "9")]
    pub locks: Option<KeyLocks>,
}

#[derive(Clone, PartialEq, Message)]
pub struct MouseInput {
    #[prost(int32, optional, tag = "1")]
    pub x: Option<i32>,
    #[prost(int32, optional, tag = "2")]
    pub y: Option<i32>,
    #[prost(int32, optional, tag = "5")]
    pub button: Option<i32>,
    #[prost(bool, optional, tag = "6")]
    pub button_down: Option<bool>,
    #[prost(float, optional, tag = "7")]
    pub wheel_delta_x: Option<f32>,
    #[prost(float, optional, tag = "8")]
    pub wheel_delta_y: Option<f32>,
    #[prost(message, optional, tag = "24")]
    pub position: Option<PointD>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PointD {
    #[prost(double, required, tag = "1")]
    pub x: f64,
    #[prost(double, required, tag = "2")]
    pub y: f64,
}

#[derive(Clone, PartialEq, Message)]
pub struct KeyInput {
    #[prost(bool, optional, tag = "2")]
    pub pressed: Option<bool>,
    #[prost(uint32, optional, tag = "3")]
    pub usb_keycode: Option<u32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct KeyLocks {
    #[prost(bool, optional, tag = "1")]
    pub caps_lock: Option<bool>,
    #[prost(bool, optional, tag = "2")]
    pub num_lock: Option<bool>,
    #[prost(bool, optional, tag = "3")]
    pub scroll_lock: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct TextInput {
    #[prost(string, optional, tag = "1")]
    pub text: Option<String>,
    #[prost(bool, optional, tag = "2")]
    pub down: Option<bool>,
}
impl fmt::Debug for TextInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TextInput([redacted])")
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct Clipboard {
    #[prost(message, optional, tag = "1")]
    pub available: Option<ClipboardAvailable>,
    #[prost(message, optional, tag = "2")]
    pub request: Option<ClipboardRequest>,
    #[prost(message, optional, tag = "3")]
    pub content: Option<ClipboardContent>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ClipboardAvailable {
    #[prost(int32, repeated, packed = "false", tag = "1")]
    pub types: Vec<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ClipboardRequest {
    #[prost(int32, optional, tag = "1")]
    pub content_type: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct ClipboardContent {
    #[prost(int32, optional, tag = "1")]
    pub content_type: Option<i32>,
    #[prost(bytes = "vec", optional, tag = "2")]
    pub content: Option<Vec<u8>>,
}
impl fmt::Debug for ClipboardContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClipboardContent([redacted])")
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct DisplayConfig {
    #[prost(string, optional, tag = "1")]
    pub current_display_id: Option<String>,
    #[prost(message, repeated, tag = "2")]
    pub displays: Vec<DisplayInfo>,
}

#[derive(Clone, PartialEq, Message)]
pub struct DisplayInfo {
    #[prost(string, optional, tag = "1")]
    pub id: Option<String>,
    #[prost(message, optional, tag = "2")]
    pub capture_rect: Option<Rect>,
    #[prost(int32, optional, tag = "3")]
    pub flags: Option<i32>,
    #[prost(message, optional, tag = "4")]
    pub local_rect: Option<Rect>,
    #[prost(message, optional, tag = "5")]
    pub pixels: Option<Size>,
    #[prost(float, optional, tag = "6")]
    pub scale_factor: Option<f32>,
    #[prost(int32, optional, tag = "7")]
    pub rotation_degrees: Option<i32>,
    #[prost(int32, optional, tag = "10")]
    pub refresh_rate: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct Rect {
    #[prost(int32, required, tag = "1")]
    pub x: i32,
    #[prost(int32, required, tag = "2")]
    pub y: i32,
    #[prost(int32, required, tag = "3")]
    pub width: i32,
    #[prost(int32, required, tag = "4")]
    pub height: i32,
}

#[derive(Clone, PartialEq, Message)]
pub struct Size {
    #[prost(uint32, required, tag = "1")]
    pub width: u32,
    #[prost(uint32, required, tag = "2")]
    pub height: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct PointerRequest {
    #[prost(bool, optional, tag = "1")]
    pub push_images: Option<bool>,
    #[prost(string, optional, tag = "2")]
    pub image_id: Option<String>,
    #[prost(bool, optional, tag = "3")]
    pub push_position: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PointerUpdate {
    #[prost(message, optional, tag = "1")]
    pub changed: Option<PointerChanged>,
    #[prost(message, optional, tag = "2")]
    pub image: Option<PointerImage>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PointerChanged {
    #[prost(string, optional, tag = "1")]
    pub pointer_id: Option<String>,
    #[prost(message, optional, tag = "2")]
    pub position: Option<Point>,
    #[prost(bool, optional, tag = "3")]
    pub visible: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
pub struct Point {
    #[prost(int32, required, tag = "1")]
    pub x: i32,
    #[prost(int32, required, tag = "2")]
    pub y: i32,
}

#[derive(Clone, PartialEq, Message)]
pub struct PointerImage {
    #[prost(string, optional, tag = "1")]
    pub pointer_id: Option<String>,
    #[prost(message, optional, tag = "2")]
    pub hotspot: Option<Point>,
    #[prost(message, optional, tag = "3")]
    pub image: Option<PointerBitmap>,
}

#[derive(Clone, PartialEq, Message)]
#[prost(skip_debug)]
pub struct PointerBitmap {
    #[prost(message, optional, tag = "1")]
    pub size: Option<Size>,
    #[prost(int32, optional, tag = "2")]
    pub format: Option<i32>,
    #[prost(bytes = "vec", optional, tag = "3")]
    pub pixels: Option<Vec<u8>>,
    #[prost(uint32, optional, tag = "4")]
    pub scale_factor100: Option<u32>,
}
impl fmt::Debug for PointerBitmap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PointerBitmap")
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct MediaControl {
    #[prost(string, optional, tag = "1")]
    pub stream_id: Option<String>,
    #[prost(bool, optional, tag = "2")]
    pub suspend: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PeerError {
    #[prost(int32, optional, tag = "1")]
    pub code: Option<i32>,
    #[prost(string, optional, tag = "2")]
    pub message: Option<String>,
    #[prost(int32, optional, tag = "3")]
    pub interactive_failure: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct CompressionStart {
    #[prost(int32, optional, tag = "1")]
    pub compression_type: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ConnectionControl {
    #[prost(uint32, optional, tag = "1")]
    pub target_bitrate_bps: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing;

    #[test]
    fn observed_envelope_tags_and_explicit_false_match_wire_vectors() {
        let hello = Control {
            peer_info: Some(PeerInfo::default()),
            ..Default::default()
        };
        assert_eq!(framing::encode(&hello).unwrap(), [2, 58, 0]);
        let interactive = Control {
            auth: Some(HostAuth {
                interactive: Some(Empty {}),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(framing::encode(&interactive).unwrap(), [4, 10, 2, 26, 0]);
        let desktop = Control {
            desktop_client: Some(DesktopClient {
                add_media: Some(AddDesktopMedia {
                    suspended: Some(false),
                    add_system_audio: Some(true),
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            framing::encode(&desktop).unwrap(),
            [8, 18, 6, 18, 4, 8, 0, 16, 1]
        );
        let subscribe = Control {
            desktop_client: Some(DesktopClient {
                pointer_request: Some(PointerRequest {
                    push_images: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            framing::encode(&subscribe).unwrap(),
            [6, 18, 4, 42, 2, 8, 1]
        );
        let mut decoder = framing::Decoder::default();
        decoder
            .push(&[11, 50, 9, 26, 7, 10, 5, 10, 1, 65, 24, 0])
            .unwrap();
        let change = decoder
            .next_message::<Control>()
            .unwrap()
            .unwrap()
            .desktop_server
            .unwrap()
            .pointer_update
            .unwrap()
            .changed
            .unwrap();
        assert_eq!(change.pointer_id.as_deref(), Some("A"));
        assert_eq!(change.visible, Some(false));
    }

    #[test]
    fn zero_access_update_is_distinct_from_no_update_and_unknown_fields_are_ignored() {
        let zero = Control::decode([10, 2, 32, 0, 250, 1, 0].as_slice()).unwrap();
        assert_eq!(zero.auth.unwrap().access_mask_updated, Some(0));
        assert_eq!(HostAuth::default().access_mask_updated, None);
    }

    #[test]
    fn sensitive_fields_do_not_appear_in_nested_debug_output() {
        let message = Control {
            auth: Some(HostAuth {
                userpass: Some(UsernamePassword {
                    username: Some("synthetic-user".into()),
                    password: Some("synthetic-pass".into()),
                }),
                ..Default::default()
            }),
            desktop_client: Some(DesktopClient {
                input: Some(InputEvent {
                    text: Some(TextInput {
                        text: Some("synthetic-text".into()),
                        down: Some(true),
                    }),
                    ..Default::default()
                }),
                clipboard: Some(Clipboard {
                    content: Some(ClipboardContent {
                        content_type: Some(1),
                        content: Some(b"synthetic-clipboard".to_vec()),
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let debug = format!("{message:?}");
        assert!(!debug.contains("synthetic"));
        assert!(debug.contains("[redacted]"));
    }
}
