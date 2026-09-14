use super::*;
use crabfleet_fluid::{
    control::{Control, MediaControl},
    framing,
};
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen(module = "/src/browser/test_peer.js")]
extern "C" {
    type BrowserHost;
    #[wasm_bindgen(constructor)]
    fn new() -> BrowserHost;
    #[wasm_bindgen(method, getter)]
    fn opened(this: &BrowserHost) -> bool;
    #[wasm_bindgen(method, catch)]
    async fn accept(this: &BrowserHost, kind: &str, sdp: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch)]
    async fn candidate(
        this: &BrowserHost,
        candidate: &str,
        index: u32,
        mid: &str,
    ) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, js_name = takeSignals)]
    fn take_signals(this: &BrowserHost) -> js_sys::Array;
    #[wasm_bindgen(method, js_name = receivedBytes)]
    fn received_bytes(this: &BrowserHost) -> js_sys::Uint8Array;
    #[wasm_bindgen(method, catch, js_name = addMedia)]
    async fn add_media(this: &BrowserHost) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch)]
    async fn close(this: &BrowserHost) -> Result<JsValue, JsValue>;
    async fn delay(ms: u32);
    #[wasm_bindgen(catch, js_name = decodedAudio)]
    async fn decoded_audio(rtc: &RtcPeerConnection) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name = tracksStopped)]
    fn tracks_stopped(stream: &MediaStream) -> bool;
}

fn field(value: &JsValue, name: &str) -> JsValue {
    js_sys::Reflect::get(value, &JsValue::from_str(name)).unwrap()
}
fn string(value: &JsValue, name: &str) -> String {
    field(value, name).as_string().unwrap()
}

#[derive(Default)]
struct Observed {
    opened: bool,
    descriptions: usize,
    data: Vec<u8>,
    frame: Option<VideoFrame>,
    audio_samples: u64,
}

async fn route(peer: &mut Peer, host: &BrowserHost, observed: &mut Observed) {
    let updates = peer.poll();
    if let Some(frame) = updates.frame {
        observed.frame = Some(frame);
    }
    for event in updates.events {
        match event {
            Event::Description(description) => {
                if observed.descriptions == 0 {
                    assert!(description.sdp.contains("m=application"));
                    assert!(!description.sdp.contains("m=video"));
                    assert!(!description.sdp.contains("m=audio"));
                }
                observed.descriptions += 1;
                assert!(
                    host.accept(
                        match description.kind {
                            SdpKind::Offer => "offer",
                            SdpKind::Answer => "answer",
                        },
                        &description.sdp
                    )
                    .await
                    .is_ok(),
                    "Local host rejected SDP"
                );
            }
            Event::Candidate(candidate) => {
                assert!(
                    host.candidate(
                        &candidate.candidate,
                        candidate.mline_index,
                        candidate.mid.as_deref().unwrap_or("")
                    )
                    .await
                    .is_ok(),
                    "Local host rejected ICE"
                );
            }
            Event::ControlOpened => observed.opened = true,
            Event::ControlData(data) => observed.data.extend(data),
            Event::Failed(error) => panic!("Browser adapter failed: {error}"),
            Event::NetworkLost => panic!("Local WebRTC network failed"),
            Event::AudioPlaybackBlocked => panic!("Muted or activated test audio was blocked"),
            _ => {}
        }
    }
    for event in host.take_signals().iter() {
        let description = field(&event, "description");
        if !description.is_undefined() {
            peer.set_remote_description(Description {
                kind: match string(&description, "type").as_str() {
                    "offer" => SdpKind::Offer,
                    "answer" => SdpKind::Answer,
                    _ => panic!("Unexpected SDP type"),
                },
                sdp: string(&description, "sdp"),
            })
            .unwrap();
        }
        let candidate = field(&event, "candidate");
        if !candidate.is_undefined() {
            peer.add_candidate(Candidate {
                candidate: string(&candidate, "candidate"),
                mline_index: field(&candidate, "sdpMLineIndex").as_f64().unwrap() as u32,
                mid: field(&candidate, "sdpMid").as_string(),
            })
            .unwrap();
        }
    }
    observed.audio_samples = decoded_audio(&peer.inner.rtc)
        .await
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0) as u64;
}

#[wasm_bindgen_test(async)]
async fn browser_control_media_renegotiation_and_teardown() {
    let mut peer = Peer::new(Options::default()).unwrap();
    // Firefox's live-stream playback-quality counter stays at zero.
    let zero_quality = Closure::<dyn FnMut() -> JsValue>::new(|| {
        let quality = js_sys::Object::new();
        js_sys::Reflect::set(&quality, &"totalVideoFrames".into(), &0.into()).unwrap();
        quality.into()
    });
    js_sys::Reflect::set(
        &peer.inner.video,
        &"getVideoPlaybackQuality".into(),
        zero_quality.as_ref(),
    )
    .unwrap();
    let host = BrowserHost::new();
    peer.start().unwrap();
    let message = Control {
        media_control: Some(MediaControl {
            stream_id: Some("synthetic".repeat(8192)),
            suspend: Some(false),
        }),
        ..Default::default()
    };
    let bytes = framing::encode(&message).unwrap();
    let mut observed = Observed::default();
    let mut sent = false;
    let deadline = js_sys::Date::now() + 20_000.0;
    while js_sys::Date::now() < deadline {
        route(&mut peer, &host, &mut observed).await;
        if !sent && observed.opened && host.opened() {
            peer.send_control(&bytes).unwrap();
            sent = true;
        }
        if observed.data == bytes {
            break;
        }
        delay(10).await;
    }
    assert!(
        observed.opened && host.opened(),
        "DTLS/SCTP did not connect"
    );
    assert_eq!(
        host.received_bytes().to_vec(),
        bytes,
        "Control send was truncated"
    );
    assert_eq!(
        observed.data, bytes,
        "Fragmented control echo did not arrive"
    );
    let mut decoder = framing::Decoder::default();
    decoder.push(&observed.data).unwrap();
    assert_eq!(decoder.next_message::<Control>().unwrap(), Some(message));
    decoder.finish().unwrap();
    assert!(
        observed.frame.is_none(),
        "Media appeared before renegotiation"
    );
    assert!(
        host.add_media().await.is_ok(),
        "Test media or audio gesture failed"
    );
    let deadline = js_sys::Date::now() + 20_000.0;
    while js_sys::Date::now() < deadline {
        route(&mut peer, &host, &mut observed).await;
        if observed.frame.is_some() && observed.audio_samples >= 960 {
            break;
        }
        delay(10).await;
    }
    assert!(
        observed.descriptions >= 2,
        "Media renegotiation did not finish"
    );
    let frame = observed.frame.expect("Browser video did not decode");
    assert_eq!((frame.width, frame.height), (320, 180));
    let center = (90 * 320 + 160) * 4;
    let pixel = &frame.rgba[center..center + 4];
    assert!(
        pixel[0] > 200 && pixel[1] < 30 && pixel[2] < 30 && pixel[3] == 255,
        "Decoded frame was not red: {pixel:?}"
    );
    assert!(
        observed.audio_samples >= 960,
        "Opus audio samples did not arrive"
    );
    assert!(peer.inner.audio.muted());
    assert!(!peer.inner.audio.paused());
    peer.set_audio_enabled(true).unwrap();
    assert!(!peer.inner.audio.muted());
    peer.set_audio_enabled(false).unwrap();
    let video = peer.inner.video_stream.borrow().clone().unwrap();
    let audio = peer.inner.audio_stream.borrow().clone().unwrap();
    let weak = Rc::downgrade(&peer.inner);
    peer.inner.arm_video_frame().unwrap();
    let pending_frame = peer.inner.video_frame_request.get().unwrap();
    peer.inner.arm_video_frame().unwrap();
    assert_eq!(peer.inner.video_frame_request.get(), Some(pending_frame));
    peer.close();
    peer.close();
    assert!(peer.inner.video_frame_request.get().is_none());
    assert!(peer.inner.video_frame_handler.borrow().is_none());
    assert!(!peer.inner.video_frame_ready.get());
    assert!(tracks_stopped(&video) && tracks_stopped(&audio));
    assert!(peer.inner.video.src_object().is_none() && peer.inner.audio.src_object().is_none());
    assert!(peer.send_control(&[1]).is_err());
    assert!(peer.poll().events.is_empty() && peer.poll().frame.is_none());
    assert!(host.close().await.is_ok());
    drop(peer);
    delay(50).await;
    assert!(
        weak.upgrade().is_none(),
        "Callbacks retained the closed peer"
    );
}

#[wasm_bindgen_test(async)]
async fn close_during_browser_offer_cannot_publish_late_events() {
    let mut peer = Peer::new(Options::default()).unwrap();
    let weak = Rc::downgrade(&peer.inner);
    peer.start().unwrap();
    Inner::create_description(&peer.inner, SdpKind::Offer);
    assert!(peer.inner.making_offer.get());
    peer.close();
    delay(50).await;
    let update = peer.poll();
    assert!(update.events.is_empty() && update.frame.is_none());
    assert!(peer.start().is_err());
    drop(peer);
    delay(50).await;
    assert!(weak.upgrade().is_none());
}

#[wasm_bindgen_test]
fn browser_accepts_service_stun_udp_hint_without_changing_turn_transport() {
    let servers = [
        "stun:127.0.0.1:3478?transport=udp",
        "turn:127.0.0.1:3478?transport=udp",
        "turn:127.0.0.1:3478?transport=tcp",
        "turns:127.0.0.1:3478?transport=tcp",
    ];
    let mut peer = Peer::new(Options {
        ice_servers: servers
            .iter()
            .map(|uri| crate::IceServer {
                uri: (*uri).into(),
                username: Some("synthetic".into()),
                password: Some("synthetic".into()),
            })
            .collect(),
        ..Default::default()
    })
    .expect("The service STUN hint must not prevent browser peer construction");
    assert_eq!(browser_ice_uri(servers[0]), "stun:127.0.0.1:3478");
    for uri in &servers[1..] {
        assert_eq!(browser_ice_uri(uri), *uri);
    }
    for uri in [
        "stun:127.0.0.1:3478?transport=tcp",
        "stun:127.0.0.1:3478?other=udp",
    ] {
        assert_eq!(browser_ice_uri(uri), uri);
        assert!(
            Peer::new(Options {
                ice_servers: vec![crate::IceServer {
                    uri: uri.into(),
                    username: None,
                    password: None
                }],
                ..Default::default()
            })
            .is_err(),
            "Unsupported STUN queries must remain rejected"
        );
    }
    peer.close();
}
