//! Optional real Chromium interop. The child pipe carries local test SDP only.
use super::*;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;

struct Browser {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: mpsc::Receiver<String>,
}
impl Browser {
    fn new() -> Self {
        let mut child = Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/native/tests/browser_peer.cjs"
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("Could not start Node browser fixture");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, replies) = mpsc::sync_channel(2);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() > 2 * MAX_SDP_BYTES || send.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            replies,
        }
    }
    fn exchange(&mut self, command: Value) -> Value {
        let stdin = self.stdin.as_mut().unwrap();
        serde_json::to_writer(&mut *stdin, &command).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
        let line = self
            .replies
            .recv_timeout(Duration::from_secs(15))
            .expect("Browser fixture did not reply within 15 seconds");
        let value: Value = serde_json::from_str(&line).expect("Invalid browser fixture response");
        assert_eq!(value["ok"], true, "Browser fixture operation failed");
        value
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "requires Node, Playwright, and Chromium; see rtc/README.md"]
fn native_control_video_audio_with_real_chromium() {
    let mut browser = Browser::new();
    let mut native = Peer::new(Options::default()).unwrap();
    native
        .inner
        .silent_audio_sink
        .store(true, Ordering::Release);
    native.start().unwrap();
    let payload = vec![0xa5; 73 * 1024];
    let after_media = b"control-after-media";
    let mut received = Vec::new();
    let mut sent = false;
    let mut browser_received = 0;
    let mut media_started = false;
    let mut media_offer_received = false;
    let mut frame = None;
    let mut audio_samples = 0;
    let mut sent_after_media = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        let mut signals = Vec::new();
        let updates = native.poll();
        frame = updates.frame.or(frame);
        audio_samples = audio_samples.max(updates.audio_samples);
        for event in updates.events {
            match event {
                Event::Description(d) => signals.push(json!({"description": {
                    "type": if d.kind == SdpKind::Offer { "offer" } else { "answer" }, "sdp": d.sdp
                }})),
                Event::Candidate(c) => signals.push(json!({"candidate": {
                    "candidate": c.candidate, "sdpMLineIndex": c.mline_index, "sdpMid": c.mid
                }})),
                Event::ControlOpened if !sent => {
                    native.send_control(&payload).unwrap();
                    sent = true;
                }
                Event::ControlData(data) => {
                    assert!(received.len() + data.len() <= payload.len() + after_media.len());
                    received.extend(data);
                }
                Event::Failed(error) => panic!("Native/browser transport failed: {error}"),
                Event::NetworkLost => panic!("Native/browser ICE connection failed"),
                _ => {}
            }
        }
        let start_media =
            !media_started && browser_received == payload.len() as u64 && received == payload;
        media_started |= start_media;
        let response = browser.exchange(json!({ "signals": signals, "startMedia": start_media }));
        browser_received = response["received"].as_u64().unwrap();
        for signal in response["signals"].as_array().unwrap() {
            if let Some(d) = signal.get("description") {
                native
                    .set_remote_description(Description {
                        kind: match d["type"].as_str() {
                            Some("offer") => {
                                media_offer_received = true;
                                SdpKind::Offer
                            }
                            Some("answer") => SdpKind::Answer,
                            _ => panic!("Unexpected browser description type"),
                        },
                        sdp: d["sdp"].as_str().unwrap().into(),
                    })
                    .unwrap();
            } else if let Some(c) = signal.get("candidate") {
                native
                    .add_candidate(Candidate {
                        candidate: c["candidate"].as_str().unwrap().into(),
                        mline_index: c["sdpMLineIndex"].as_u64().unwrap().try_into().unwrap(),
                        mid: c["sdpMid"].as_str().map(str::to_owned),
                    })
                    .unwrap();
            }
        }
        if frame.is_some() && audio_samples >= 960 {
            if !sent_after_media {
                native.send_control(after_media).unwrap();
                sent_after_media = true;
            } else if received.len() == payload.len() + after_media.len()
                && browser_received == received.len() as u64
            {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(sent, "Native control channel never opened");
    assert_eq!(browser_received, (payload.len() + after_media.len()) as u64);
    assert_eq!(
        received.len(),
        payload.len() + after_media.len(),
        "Control echo was incomplete"
    );
    assert!(
        received[..payload.len()] == payload,
        "Control echo contents changed"
    );
    assert_eq!(
        &received[payload.len()..],
        after_media,
        "Control channel failed after media renegotiation"
    );
    assert!(
        media_started && media_offer_received,
        "Browser media renegotiation did not run"
    );
    let frame = frame.expect("Chrome video did not decode on the native adapter");
    assert_eq!((frame.width, frame.height), (320, 180));
    let center = ((90 * 320 + 160) * 4) as usize;
    let pixel = &frame.rgba[center..center + 4];
    assert!(
        pixel[0] > 200 && pixel[1] < 30 && pixel[2] < 30 && pixel[3] == 255,
        "Decoded browser video was not red: {pixel:?}"
    );
    assert!(
        audio_samples >= 960,
        "Chrome audio did not decode on the native adapter"
    );
    native.set_audio_enabled(true).unwrap();
    assert!(
        native
            .inner
            .volume
            .lock()
            .unwrap()
            .iter()
            .all(|volume| !volume.property::<bool>("mute"))
    );
    native.set_audio_enabled(false).unwrap();
    assert!(
        native
            .inner
            .volume
            .lock()
            .unwrap()
            .iter()
            .all(|volume| volume.property::<bool>("mute"))
    );
    native.close();
    native.close();
    let result = browser.exchange(json!({ "close": true }));
    assert_eq!(
        result["closed"], true,
        "Browser tracks, audio context, and transport must stop"
    );
    let codecs = result["codecs"].as_array().unwrap();
    assert!(
        codecs.contains(&json!("video/vp8")) && codecs.contains(&json!("audio/opus")),
        "The fixture must send VP8 and Opus; observed {codecs:?}"
    );
    if let Ok(expected) = std::env::var("CRABFLEET_TEST_SRTP_PROFILE") {
        assert!(matches!(
            expected.as_str(),
            "SRTP_AEAD_AES_256_GCM" | "SRTP_AEAD_AES_128_GCM" | "SRTP_AES128_CM_SHA1_80"
        ));
        assert_eq!(
            result["profiles"],
            json!([expected]),
            "Unexpected negotiated SRTP profile"
        );
    }
    assert!(native.poll().events.is_empty());
    let weak = Arc::downgrade(&native.inner);
    drop(native);
    let deadline = Instant::now() + Duration::from_secs(2);
    while weak.upgrade().is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        weak.upgrade().is_none(),
        "Native callbacks retained the closed adapter"
    );
}
