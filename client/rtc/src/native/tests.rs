use super::*;
use crabfleet_fluid::{
    control::{Control, Empty, MediaControl},
    framing,
};
use std::time::{Duration, Instant};

mod browser_interop;

#[test]
fn media_answers_exclude_unimplemented_receive_formats() {
    let mut sender = Peer::new(Options::default()).unwrap();
    add_media_sender(&sender);
    sender.start().unwrap();
    let mut receiver = Peer::new(Options::default()).unwrap();
    receiver.start_as(false).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut offered = false;
    let mut answered = false;
    while Instant::now() < deadline && !answered {
        for event in sender.poll().events {
            if !offered && let Event::Description(mut description) = event {
                assert_eq!(description.kind, SdpKind::Offer);
                let mut sdp =
                    gst_sdp::SDPMessage::parse_buffer(description.sdp.as_bytes()).unwrap();
                let video = sdp
                    .medias_mut()
                    .find(|media| media.media() == Some("video"))
                    .unwrap();
                assert!(!video.formats().any(|format| format == "125"));
                video.add_format("125");
                video.add_attribute("rtpmap", Some("125 AV1/90000"));
                description.sdp = sdp.as_text().unwrap();
                receiver.set_remote_description(description).unwrap();
                offered = true;
            }
        }
        for event in receiver.poll().events {
            match event {
                Event::Description(description) => {
                    assert_eq!(description.kind, SdpKind::Answer);
                    let sdp =
                        gst_sdp::SDPMessage::parse_buffer(description.sdp.as_bytes()).unwrap();
                    let video = sdp
                        .medias()
                        .find(|media| media.media() == Some("video"))
                        .unwrap();
                    assert!(
                        video.formats().any(|format| format == "96"),
                        "Supported VP8 must remain available"
                    );
                    assert!(
                        !video.formats().any(|format| format == "125"),
                        "AV1 must not be accepted without an implemented receive pipeline"
                    );
                    answered = true;
                }
                Event::Failed(error) => panic!("Local codec negotiation failed: {error}"),
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        offered && answered,
        "Local media negotiation did not complete"
    );
    receiver.close();
    sender.close();
}

#[test]
fn missing_decoder_diagnostics_do_not_expose_remote_caps() {
    gst::init().unwrap();
    let caps = gst::Caps::builder("video/x-h264")
        .field("profile", "high-4:4:4")
        .field("remote-private-field", "synthetic-secret")
        .build();
    let message = gst::Structure::builder("missing-plugin")
        .field("type", "decoder")
        .field("detail", caps)
        .field("name", "synthetic-secret")
        .build();
    assert_eq!(
        missing_decoder(&message),
        Some("A decoder for the host's H.264 profile is missing; install GStreamer's libav plugin")
    );
    let mut unknown = message.clone();
    unknown.set(
        "detail",
        gst::Caps::builder("application/x-synthetic-secret").build(),
    );
    assert!(
        !missing_decoder(&unknown)
            .unwrap()
            .contains("synthetic-secret")
    );
    unknown.set("type", "element");
    assert!(missing_decoder(&unknown).is_none());
    let malformed = gst::Structure::builder("missing-plugin")
        .field("type", "decoder")
        .field("detail", "synthetic-secret")
        .build();
    assert!(missing_decoder(&malformed).is_none());
}

#[test]
fn media_answers_keep_the_existing_bundle_role_and_reject_conflicts() {
    gst::init().unwrap();
    let source = concat!(
        "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
        "a=group:BUNDLE data video\r\n",
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
        "a=mid:data\r\na=setup:active\r\na=fingerprint:sha-256 synthetic\r\n",
        "a=ice-ufrag:synthetic\r\na=sctp-port:5000\r\n",
        "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
        "a=mid:video\r\na=setup:active\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\n",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        "a=mid:separate\r\na=setup:active\r\na=recvonly\r\na=rtpmap:111 opus/48000/2\r\n",
    );
    let offer = gst_sdp::SDPMessage::parse_buffer(
        source
            .replace("a=setup:active", "a=setup:actpass")
            .as_bytes(),
    )
    .unwrap();
    for client in [false, true] {
        let before = if client {
            source.replace("a=setup:active", "a=setup:passive")
        } else {
            source.to_owned()
        };
        let mut answer = gst_sdp::SDPMessage::parse_buffer(before.as_bytes()).unwrap();
        preserve_answer_role(&mut answer, &offer, 0, client).unwrap();
        let expected = if client {
            before.replacen("a=setup:passive", "a=setup:active", 2)
        } else {
            before.replacen("a=setup:active", "a=setup:passive", 2)
        };
        assert_eq!(
            answer.as_text().unwrap(),
            expected,
            "Only setup attributes on the established transport may change"
        );

        let conflicting = source.replace(
            "a=setup:active",
            if client {
                "a=setup:active"
            } else {
                "a=setup:passive"
            },
        );
        let conflicting = gst_sdp::SDPMessage::parse_buffer(conflicting.as_bytes()).unwrap();
        assert!(
            preserve_answer_role(&mut answer, &conflicting, 0, client).is_err(),
            "An explicit offer role must not be silently contradicted"
        );
    }
}

#[test]
fn turn_userinfo_is_escaped_and_never_appears_in_debug() {
    let server = IceServer {
        uri: "turns:relay.example.test:5349?transport=tcp".into(),
        username: Some("100:viewer".into()),
        password: Some("a/b+c=@x".into()),
    };
    assert_eq!(
        ice_uri(&server).unwrap().1,
        "turns://100%3Aviewer:a%2Fb%2Bc%3D%40x@relay.example.test:5349?transport=tcp"
    );
    assert_eq!(format!("{server:?}"), "IceServer([redacted])");
    for uri in [
        "https://example.test",
        "turn:someone@host:3",
        "turn:host:3?x=y",
        "stun:bad host",
    ] {
        assert!(
            ice_uri(&IceServer {
                uri: uri.into(),
                ..server.clone()
            })
            .is_err()
        );
    }
}

fn add_media_sender(peer: &Peer) {
    for source in [
        "videotestsrc is-live=true pattern=red ! video/x-raw,width=320,height=180,framerate=15/1 ! vp8enc deadline=1 cpu-used=8 keyframe-max-dist=15 ! rtpvp8pay pt=96 ssrc=1001 ! capsfilter caps=\"application/x-rtp,media=video,encoding-name=VP8,payload=96,clock-rate=90000,ssrc=(uint)1001\"",
        "audiotestsrc is-live=true wave=silence ! audio/x-raw,rate=48000,channels=2 ! opusenc ! rtpopuspay pt=97 ssrc=1002 ! capsfilter caps=\"application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000,encoding-params=(string)2,ssrc=(uint)1002\"",
    ] {
        let source = gst::parse::bin_from_description(source, true).unwrap();
        peer.inner.pipeline.add(&source).unwrap();
        let sink = peer.inner.rtc.request_pad_simple("sink_%u").unwrap();
        let transceiver = sink
            .property::<gst_webrtc::WebRTCRTPTransceiver>("transceiver")
            .downgrade();
        let output = source.static_pad("src").unwrap();
        // An existing data-channel transport is already writable. Keep new RTP
        // out of it until the receiver has accepted this track's negotiation.
        output.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            if transceiver.upgrade().is_some_and(|transceiver| {
                matches!(
                    transceiver.current_direction(),
                    gst_webrtc::WebRTCRTPTransceiverDirection::Sendonly
                        | gst_webrtc::WebRTCRTPTransceiverDirection::Sendrecv
                )
            }) {
                gst::PadProbeReturn::Ok
            } else {
                gst::PadProbeReturn::Drop
            }
        });
        output.link(&sink).unwrap();
        source.sync_state_with_parent().unwrap();
    }
}

#[derive(Default)]
struct Observed {
    opened: bool,
    descriptions: usize,
    data: Vec<u8>,
    frame: Option<VideoFrame>,
    audio_samples: u64,
}

fn route(source: &mut Peer, destination: &mut Peer, observed: &mut Observed) {
    let updates = source.poll();
    observed.audio_samples = updates.audio_samples;
    if let Some(frame) = updates.frame {
        observed.frame = Some(frame);
    }
    for event in updates.events {
        match event {
            Event::Description(description) => {
                observed.descriptions += 1;
                destination.set_remote_description(description).unwrap();
            }
            Event::Candidate(candidate) => destination.add_candidate(candidate).unwrap(),
            Event::ControlOpened => observed.opened = true,
            Event::ControlData(data) => observed.data.extend(data),
            Event::Failed(error) => panic!("Local WebRTC test failed: {error}"),
            _ => {}
        }
    }
}

#[test]
fn encrypted_control_video_audio_and_close_over_real_webrtc() {
    let mut sender = Peer::new(Options::default()).unwrap();
    let mut receiver = Peer::new(Options::default()).unwrap();
    receiver
        .inner
        .silent_audio_sink
        .store(true, Ordering::Release);
    add_media_sender(&sender);
    receiver.start_as(false).unwrap();
    sender.start().unwrap();
    let mut sent = false;
    let mut left = Observed::default();
    let mut right = Observed::default();
    let message = Control {
        // A long opaque value exercises fragmentation and ordered reconstruction.
        media_control: Some(MediaControl {
            stream_id: Some("synthetic".repeat(8192)),
            suspend: Some(false),
        }),
        ..Default::default()
    };
    let bytes = framing::encode(&message).unwrap();
    let reply = Control {
        ping: Some(Empty {}),
        ..Default::default()
    };
    let reply_bytes = framing::encode(&reply).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        route(&mut sender, &mut receiver, &mut left);
        route(&mut receiver, &mut sender, &mut right);
        if !sent && left.opened && right.opened {
            sender.send_control(&bytes).unwrap();
            receiver.send_control(&reply_bytes).unwrap();
            sent = true;
        }
        if right.frame.is_some()
            && right.audio_samples >= 960
            && right.data == bytes
            && left.data == reply_bytes
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        left.opened && right.opened,
        "DTLS/SCTP did not open the control channels"
    );
    assert!(
        left.descriptions > 0 && right.descriptions > 0,
        "SDP exchange did not complete"
    );
    assert_eq!(
        right.data.len(),
        bytes.len(),
        "Fragmented control message did not arrive"
    );
    assert_eq!(
        left.data, reply_bytes,
        "Reverse control message did not arrive"
    );
    let mut decoder = framing::Decoder::default();
    decoder.push(&right.data).unwrap();
    assert_eq!(decoder.next_message::<Control>().unwrap(), Some(message));
    decoder.finish().unwrap();
    let frame = right.frame.expect("VP8 video did not decode");
    assert_eq!((frame.width, frame.height), (320, 180));
    let center = ((90 * 320 + 160) * 4) as usize;
    let pixel = &frame.rgba[center..center + 4];
    assert!(
        pixel[0] > 200 && pixel[1] < 30 && pixel[2] < 30 && pixel[3] == 255,
        "Decoded test video was not red: {pixel:?}"
    );
    assert!(right.audio_samples >= 960, "Opus audio did not decode");
    receiver.set_audio_enabled(true).unwrap();
    receiver.set_audio_enabled(false).unwrap();
    let weak_sender = Arc::downgrade(&sender.inner);
    let weak_receiver = Arc::downgrade(&receiver.inner);
    sender.close();
    receiver.close();
    receiver.close();
    assert!(receiver.send_control(&reply_bytes).is_err());
    assert!(receiver.poll().events.is_empty());
    drop(sender);
    drop(receiver);
    assert!(
        weak_sender.upgrade().is_none(),
        "Sender callbacks leaked the peer"
    );
    assert!(
        weak_receiver.upgrade().is_none(),
        "Receiver callbacks leaked the peer"
    );
}

#[test]
fn oversized_remote_messages_and_pending_candidates_are_bounded() {
    let mut peer = Peer::new(Options::default()).unwrap();
    assert!(
        peer.set_remote_description(Description {
            kind: SdpKind::Offer,
            sdp: "x".repeat(MAX_SDP_BYTES + 1)
        })
        .is_err()
    );
    assert!(peer.send_control(&vec![0; MAX_CONTROL_BYTES + 1]).is_err());
    let candidate = Candidate {
        candidate: "candidate:synthetic".into(),
        mline_index: 0,
        mid: None,
    };
    for _ in 0..MAX_PENDING_CANDIDATES {
        peer.add_candidate(candidate.clone()).unwrap();
    }
    assert!(peer.add_candidate(candidate).is_err());
    peer.close();
    assert!(peer.inner.negotiation.lock().unwrap().candidates.is_empty());
}

#[test]
fn connection_negotiation_has_a_deadline_and_failure_is_delivered_once() {
    use crate::connection::{Connection, Failure};
    use crabfleet_fluid::session;
    let mut connection = Connection::new(Options::default(), true, 100).unwrap();
    let update = connection.poll(45_101);
    assert_eq!(
        update.failure,
        Some(Failure::Transport(Error("WebRTC negotiation timed out")))
    );
    assert!(update.transport.is_empty());
    assert!(update.frame.is_none());
    assert_eq!(connection.state(), session::State::Ended);
    assert!(connection.poll(45_102).failure.is_none());
    connection.close();
}

#[test]
fn fluid_session_authenticates_then_negotiates_media_and_revokes_input() {
    use crate::connection::Connection;
    use crabfleet_fluid::{
        control::{
            DesktopServer, HostAuth, InputEvent, KeyInput, PeerInfo, Point, PointerBitmap,
            PointerChanged, PointerImage, PointerUpdate, Size,
        },
        session,
    };
    let clock = Instant::now();
    let mut client = Connection::new(Options::default(), true, 0).unwrap();
    let mut host = Peer::new(Options::default()).unwrap();
    host.start_as(false).unwrap();
    let mut host_decoder = framing::Decoder::default();
    let mut authenticated = false;
    let mut media_requested = false;
    let mut got_frame = false;
    let mut pressed = false;
    let mut released = false;
    let mut revoked = false;
    let mut got_cursor = false;
    let mut cursor_stopped = false;
    let mut committed_text = Vec::new();
    let mut clipboard_available = false;
    let mut clipboard_content = false;
    let mut paste_keys = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let update = client.poll(clock.elapsed().as_millis() as u64);
        assert!(
            update.failure.is_none(),
            "Client failed: {:?}",
            update.failure
        );
        for event in update.transport {
            match event {
                Event::Description(description) => {
                    host.set_remote_description(description).unwrap()
                }
                Event::Candidate(candidate) => host.add_candidate(candidate).unwrap(),
                _ => {}
            }
        }
        if update.frame.is_some() {
            assert!(
                authenticated && media_requested,
                "Video escaped before host authentication"
            );
            if !got_frame && got_cursor {
                assert!(client.supports_text_input());
                client.set_clipboard_enabled(true);
                client.commit_text("café 🦀".into()).unwrap();
                client.paste_text(b"synthetic clipboard").unwrap();
                client
                    .input(InputEvent {
                        key: Some(KeyInput {
                            pressed: Some(true),
                            usb_keycode: Some(0x70004),
                        }),
                        ..Default::default()
                    })
                    .unwrap();
                got_frame = true;
            }
        }
        for event in update.session {
            if let session::Event::Cursor(cursor) = &event {
                assert!(!revoked);
                if let Some(image) = &cursor.image {
                    assert_eq!(image.size, [2, 2]);
                    assert_eq!(image.hotspot, [1, 0]);
                    assert_eq!(image.scale_factor100, 200);
                    assert_eq!(image.rgba, [255; 16]);
                    got_cursor = true;
                }
            }
            if let session::Event::Permissions(permissions) = event
                && !permissions.can_view()
            {
                revoked = true;
                assert!(update.view_revoked);
                assert!(update.frame.is_none());
                assert!(client.commit_text("blocked".into()).is_err());
                assert!(client.paste_text(b"blocked").is_err());
                assert!(
                    client
                        .input(InputEvent {
                            key: Some(KeyInput {
                                pressed: Some(true),
                                usb_keycode: Some(0x70004)
                            }),
                            ..Default::default()
                        })
                        .is_err()
                );
            }
        }
        for event in host.poll().events {
            match event {
                Event::Description(description) => {
                    client.set_remote_description(description).unwrap()
                }
                Event::Candidate(candidate) => client.add_candidate(candidate).unwrap(),
                Event::ControlOpened => host
                    .send_control(
                        &framing::encode(&Control {
                            peer_info: Some(PeerInfo {
                                supports_interactive_auth: Some(true),
                                supports_text_inject_up_down: Some(true),
                                os_type: Some(1),
                                ..Default::default()
                            }),
                            ..Default::default()
                        })
                        .unwrap(),
                    )
                    .unwrap(),
                Event::ControlData(bytes) => {
                    host_decoder.push(&bytes).unwrap();
                    while let Some(message) = host_decoder.next_message::<Control>().unwrap() {
                        if message
                            .auth
                            .as_ref()
                            .is_some_and(|auth| auth.interactive.is_some())
                        {
                            assert!(!authenticated);
                            authenticated = true;
                            host.send_control(
                                &framing::encode(&Control {
                                    auth: Some(HostAuth {
                                        access_mask_updated: Some(7),
                                        ..Default::default()
                                    }),
                                    ..Default::default()
                                })
                                .unwrap(),
                            )
                            .unwrap();
                        }
                        if let Some(desktop) = message.desktop_client {
                            if let Some(request) = desktop.pointer_request {
                                assert!(authenticated);
                                let pointer = if request.push_images == Some(true) {
                                    PointerUpdate {
                                        changed: Some(PointerChanged {
                                            pointer_id: Some("arrow".into()),
                                            visible: Some(true),
                                            ..Default::default()
                                        }),
                                        ..Default::default()
                                    }
                                } else if request.image_id.as_deref() == Some("arrow") {
                                    PointerUpdate {
                                        image: Some(PointerImage {
                                            pointer_id: Some("arrow".into()),
                                            hotspot: Some(Point { x: 1, y: 0 }),
                                            image: Some(PointerBitmap {
                                                size: Some(Size {
                                                    width: 2,
                                                    height: 2,
                                                }),
                                                format: Some(1),
                                                pixels: Some(vec![255; 16]),
                                                scale_factor100: Some(200),
                                            }),
                                        }),
                                        ..Default::default()
                                    }
                                } else {
                                    assert_eq!(request.push_images, Some(false));
                                    cursor_stopped = true;
                                    PointerUpdate::default()
                                };
                                host.send_control(
                                    &framing::encode(&Control {
                                        desktop_server: Some(DesktopServer {
                                            pointer_update: Some(pointer),
                                            ..Default::default()
                                        }),
                                        ..Default::default()
                                    })
                                    .unwrap(),
                                )
                                .unwrap();
                            }
                            if desktop.add_media.is_some() {
                                assert!(authenticated && !media_requested);
                                media_requested = true;
                                // A host adds media after authorization, requiring a new offer.
                                add_media_sender(&host);
                            }
                            if let Some(clipboard) = desktop.clipboard {
                                if let Some(available) = clipboard.available {
                                    assert_eq!(available.types, [1]);
                                    clipboard_available = true;
                                }
                                if let Some(content) = clipboard.content {
                                    assert!(clipboard_available);
                                    assert_eq!(content.content_type, Some(1));
                                    assert_eq!(
                                        content.content.as_deref(),
                                        Some(b"synthetic clipboard".as_slice())
                                    );
                                    clipboard_content = true;
                                }
                            }
                            if let Some(text) =
                                desktop.input.as_ref().and_then(|input| input.text.as_ref())
                            {
                                assert_eq!(text.text.as_deref(), Some("café 🦀"));
                                committed_text.push(text.down.unwrap());
                            }
                            if let Some(key) = desktop.input.and_then(|input| input.key) {
                                if key.usb_keycode != Some(0x70004) {
                                    assert!(
                                        clipboard_content,
                                        "Paste shortcut arrived before clipboard content"
                                    );
                                    paste_keys
                                        .push((key.usb_keycode.unwrap(), key.pressed.unwrap()));
                                    continue;
                                }
                                if key.pressed == Some(true) {
                                    pressed = true;
                                    host.send_control(
                                        &framing::encode(&Control {
                                            auth: Some(HostAuth {
                                                access_mask_updated: Some(0),
                                                ..Default::default()
                                            }),
                                            ..Default::default()
                                        })
                                        .unwrap(),
                                    )
                                    .unwrap();
                                } else {
                                    released = true;
                                }
                            }
                        }
                    }
                }
                Event::Failed(error) => panic!("Local host failed: {error}"),
                _ => {}
            }
        }
        if got_frame && got_cursor && cursor_stopped && pressed && released && revoked {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        authenticated && media_requested && got_frame && pressed && released && revoked,
        "Incomplete Fluid session: auth={authenticated}, media={media_requested}, frame={got_frame}, pressed={pressed}, released={released}, revoked={revoked}"
    );
    assert!(got_cursor && cursor_stopped);
    assert_eq!(committed_text, [false]);
    assert!(clipboard_content);
    assert_eq!(
        paste_keys,
        [
            (0x700e3, true),
            (0x70019, true),
            (0x70019, false),
            (0x700e3, false)
        ]
    );
    client.close();
    client.close();
    assert_eq!(client.state(), session::State::Ended);
    assert!(
        client
            .poll(clock.elapsed().as_millis() as u64)
            .frame
            .is_none()
    );
    host.close();
}
