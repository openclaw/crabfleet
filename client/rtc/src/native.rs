use crate::{
    Candidate, ConnectionState, Description, Error, Event, IceServer, MAX_BUFFERED_BYTES,
    MAX_CONTROL_BYTES, MAX_SDP_BYTES, Options, SdpKind, Updates, VideoFrame, frame_bytes,
    inbox::Inbox, validate_candidate,
};
use gst::{glib, prelude::*};
use gst_video::prelude::*;
use gst_webrtc::{
    WebRTCDataChannel, WebRTCDataChannelState, WebRTCPeerConnectionState, WebRTCSDPType,
    WebRTCSessionDescription, WebRTCSignalingState,
};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

const MAX_PENDING_CANDIDATES: usize = 128;
const MAX_TRACKS: usize = 8;
const CONTROL_CHUNK: usize = 16 * 1024;

#[derive(Default)]
struct Negotiation {
    making_offer: bool,
    setting_remote: bool,
    remote_ready: bool,
    ignore_offer: bool,
    candidates: Vec<Candidate>,
}

struct Inner {
    pipeline: gst::Pipeline,
    rtc: gst::Element,
    channel: Mutex<Option<WebRTCDataChannel>>,
    inbox: Mutex<Inbox>,
    negotiation: Mutex<Negotiation>,
    alive: AtomicBool,
    started: AtomicBool,
    audio_enabled: AtomicBool,
    volume: Mutex<Vec<gst::Element>>,
    tracks: AtomicUsize,
    missing_decoder: Mutex<Option<&'static str>>,
    #[cfg(test)]
    silent_audio_sink: AtomicBool,
}

/// Own one connection on a networking worker. `poll` drains events and closes failed
/// pipelines; dropping the peer releases all GStreamer resources. Never log SDP.
pub struct Peer {
    inner: Arc<Inner>,
}

impl Peer {
    pub fn new(options: Options) -> Result<Self, Error> {
        gst::init().map_err(|_| Error("GStreamer could not initialize"))?;
        if options.ice_servers.len() > 32 {
            return Err(Error("Too many ICE servers"));
        }
        let rtc = element("webrtcbin")?;
        rtc.set_property_from_str("bundle-policy", "max-bundle");
        rtc.set_property("latency", 40u32);
        let mut has_stun = false;
        for server in &options.ice_servers {
            let (turn, uri) = ice_uri(server)?;
            if turn {
                if !rtc.emit_by_name::<bool>("add-turn-server", &[&uri]) {
                    return Err(Error("GStreamer rejected a TURN server"));
                }
            } else if !has_stun {
                rtc.set_property("stun-server", &uri);
                has_stun = true;
            }
        }
        let pipeline = gst::Pipeline::new();
        pipeline
            .add(&rtc)
            .map_err(|_| Error("Could not create the WebRTC pipeline"))?;
        let inner = Arc::new(Inner {
            pipeline,
            rtc,
            channel: Mutex::new(None),
            inbox: Mutex::new(Inbox::default()),
            negotiation: Mutex::new(Negotiation::default()),
            alive: AtomicBool::new(true),
            started: AtomicBool::new(false),
            audio_enabled: AtomicBool::new(options.audio_enabled),
            volume: Mutex::new(Vec::new()),
            tracks: AtomicUsize::new(0),
            missing_decoder: Mutex::new(None),
            #[cfg(test)]
            silent_audio_sink: AtomicBool::new(false),
        });
        Inner::install(&inner);
        Ok(Self { inner })
    }

    /// Create the ordered control channel and start the initial offer.
    pub fn start(&mut self) -> Result<(), Error> {
        self.start_as(true)
    }

    fn start_as(&mut self, initiate: bool) -> Result<(), Error> {
        self.ensure_live()?;
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return Err(Error("WebRTC peer has already started"));
        }
        self.inner
            .pipeline
            .set_state(gst::State::Ready)
            .map_err(|_| Error("WebRTC runtime components are unavailable"))?;
        if initiate {
            let channel = self
                .inner
                .rtc
                .emit_by_name::<Option<WebRTCDataChannel>>(
                    "create-data-channel",
                    &[&"rtc", &None::<gst::Structure>],
                )
                .ok_or(Error("Could not create the WebRTC control channel"))?;
            Inner::install_channel(&self.inner, channel);
        }
        self.inner
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(|_| Error("Could not start the WebRTC pipeline"))?;
        if initiate {
            // A data-only peer can emit negotiation-needed during channel creation,
            // before the channel has been installed in our state.
            Inner::create_description(&self.inner, SdpKind::Offer);
        }
        Ok(())
    }

    pub fn set_remote_description(&mut self, description: Description) -> Result<(), Error> {
        self.ensure_live()?;
        if description.sdp.is_empty() || description.sdp.len() > MAX_SDP_BYTES {
            return Err(Error("Invalid SDP size"));
        }
        let sdp = gst_sdp::SDPMessage::parse_buffer(description.sdp.as_bytes())
            .map_err(|_| Error("Invalid remote SDP"))?;
        if sdp.medias_len() > (MAX_TRACKS + 1) as u32 {
            return Err(Error("Remote SDP has too many media sections"));
        }
        let offer = description.kind == SdpKind::Offer;
        {
            let mut negotiation = self.inner.negotiation.lock().unwrap();
            let stable = self
                .inner
                .rtc
                .property::<WebRTCSignalingState>("signaling-state")
                == WebRTCSignalingState::Stable;
            // The observed browser client is the impolite peer during offer glare.
            if offer && (negotiation.making_offer || !stable) {
                negotiation.ignore_offer = true;
                return Ok(());
            }
            if negotiation.setting_remote {
                return Err(Error("Remote SDP operation is already pending"));
            }
            negotiation.ignore_offer = false;
            negotiation.setting_remote = true;
            negotiation.remote_ready = false;
        }
        let description = WebRTCSessionDescription::new(
            if offer {
                WebRTCSDPType::Offer
            } else {
                WebRTCSDPType::Answer
            },
            sdp,
        );
        let weak = Arc::downgrade(&self.inner);
        let promise = gst::Promise::with_change_func(move |reply| {
            let Some(inner) = live(&weak) else {
                return;
            };
            if !promise_ok(&reply) {
                inner.fail(Error("Could not apply remote SDP"));
                return;
            }
            let candidates = {
                let mut negotiation = inner.negotiation.lock().unwrap();
                negotiation.setting_remote = false;
                negotiation.remote_ready = true;
                std::mem::take(&mut negotiation.candidates)
            };
            for candidate in candidates {
                inner.add_candidate_now(candidate);
            }
            if offer {
                Inner::create_description(&inner, SdpKind::Answer);
            }
        });
        self.inner
            .rtc
            .emit_by_name::<()>("set-remote-description", &[&description, &promise]);
        Ok(())
    }

    pub fn add_candidate(&mut self, candidate: Candidate) -> Result<(), Error> {
        self.ensure_live()?;
        validate_candidate(&candidate)?;
        {
            let mut negotiation = self.inner.negotiation.lock().unwrap();
            if negotiation.ignore_offer {
                return Ok(());
            }
            if !negotiation.remote_ready {
                if negotiation.candidates.len() >= MAX_PENDING_CANDIDATES {
                    return Err(Error("Too many pending ICE candidates"));
                }
                negotiation.candidates.push(candidate);
                return Ok(());
            }
        }
        self.inner.add_candidate_now(candidate);
        Ok(())
    }

    /// Ordered stream chunks keep SCTP messages below typical peer limits. The
    /// framing layer reconstructs complete Protocol Buffers across these chunks.
    pub fn send_control(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.ensure_live()?;
        if bytes.is_empty() || bytes.len() > MAX_CONTROL_BYTES {
            return Err(Error("Invalid control message size"));
        }
        let channel = self
            .inner
            .channel
            .lock()
            .unwrap()
            .clone()
            .ok_or(Error("Control channel is not available"))?;
        if channel.ready_state() != WebRTCDataChannelState::Open {
            return Err(Error("Control channel is not open"));
        }
        if channel.buffered_amount().saturating_add(bytes.len() as u64) > MAX_BUFFERED_BYTES as u64
        {
            self.inner
                .fail(Error("Control channel write queue exceeded its limit"));
            return Err(Error("Control channel write queue exceeded its limit"));
        }
        for chunk in bytes.chunks(CONTROL_CHUNK) {
            if channel
                .send_data_full(Some(&glib::Bytes::from(chunk)))
                .is_err()
            {
                self.inner.fail(Error("Control channel write failed"));
                return Err(Error("Control channel write failed"));
            }
        }
        Ok(())
    }

    pub fn set_audio_enabled(&mut self, enabled: bool) -> Result<(), Error> {
        self.ensure_live()?;
        self.inner.audio_enabled.store(enabled, Ordering::Release);
        for volume in self.inner.volume.lock().unwrap().iter() {
            volume.set_property("mute", !enabled);
        }
        Ok(())
    }

    pub fn poll(&mut self) -> Updates {
        let (updates, ended) = {
            let mut inbox = self.inner.inbox.lock().unwrap();
            (inbox.drain(), inbox.ended())
        };
        if ended {
            self.close();
        }
        updates
    }

    pub fn close(&mut self) {
        if !self.inner.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        self.inner.inbox.lock().unwrap().close();
        let channel = self.inner.channel.lock().unwrap().take();
        if let Some(channel) = channel {
            channel.close();
        }
        let _ = self.inner.pipeline.set_state(gst::State::Null);
        self.inner.volume.lock().unwrap().clear();
        self.inner.negotiation.lock().unwrap().candidates.clear();
    }

    fn ensure_live(&self) -> Result<(), Error> {
        if !self.inner.alive.load(Ordering::Acquire) || self.inner.inbox.lock().unwrap().ended() {
            return Err(Error("WebRTC peer has ended"));
        }
        Ok(())
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.close();
    }
}

impl Inner {
    fn push(&self, event: Event) {
        self.inbox.lock().unwrap().push(event);
    }
    fn fail(&self, error: Error) {
        self.inbox.lock().unwrap().fail(error);
    }

    fn install(inner: &Arc<Self>) {
        // webrtcbin negotiates RTP; it does not discover this application's decoders.
        let codecs = receive_codecs();
        inner
            .rtc
            .connect("on-new-transceiver", false, move |values| {
                if let Ok(transceiver) = values[1].get::<gst_webrtc::WebRTCRTPTransceiver>() {
                    transceiver.set_codec_preferences(Some(&codecs));
                }
                None
            });
        let weak = Arc::downgrade(inner);
        inner
            .pipeline
            .bus()
            .expect("Pipeline always has a bus")
            .set_sync_handler(move |_, message| {
                if let Some(inner) = live(&weak)
                    && let gst::MessageView::Element(message) = message.view()
                    && let Some(description) = message.structure().and_then(missing_decoder)
                {
                    *inner.missing_decoder.lock().unwrap() = Some(description);
                }
                if let Some(inner) = live(&weak)
                    && let gst::MessageView::Error(message) = message.view()
                {
                    // Framework errors can contain SDP or TURN credentials.
                    let error = message.error();
                    eprintln!(
                        "GStreamer failure: core={:?}, resource={:?}, stream={:?}, library={:?}",
                        error.kind::<gst::CoreError>(),
                        error.kind::<gst::ResourceError>(),
                        error.kind::<gst::StreamError>(),
                        error.kind::<gst::LibraryError>(),
                    );
                    let missing_srtp = error.kind::<gst::ResourceError>()
                        == Some(gst::ResourceError::Read)
                        && message
                            .src()
                            .and_then(|source| source.downcast_ref::<gst::Element>())
                            .and_then(|element| element.factory())
                            .is_some_and(|factory| factory.name() == "dtlsdec")
                        && message.debug().is_some_and(|details| {
                            details.contains("No SRTP capabilities negotiated during handshake")
                        });
                    inner.fail(Error(if missing_srtp {
                        "The host did not negotiate the media encryption profile required by GStreamer"
                    } else if error.kind::<gst::CoreError>() == Some(gst::CoreError::MissingPlugin)
                        || error.kind::<gst::StreamError>() == Some(gst::StreamError::CodecNotFound)
                    {
                        inner.missing_decoder.lock().unwrap().unwrap_or(
                            "A required GStreamer media plugin is missing; check the native runtime dependencies",
                        )
                    } else {
                        "GStreamer reported a media or transport error"
                    }));
                }
                gst::BusSyncReply::Drop
            });
        let weak = Arc::downgrade(inner);
        inner.rtc.connect("on-negotiation-needed", false, move |_| {
            if let Some(inner) = live(&weak) {
                // A responder with no local tracks/channel has nothing to offer yet.
                if inner.channel.lock().unwrap().is_some() {
                    Inner::create_description(&inner, SdpKind::Offer);
                }
            }
            None
        });
        let weak = Arc::downgrade(inner);
        inner.rtc.connect("on-ice-candidate", false, move |values| {
            if let Some(inner) = live(&weak)
                && let (Ok(index), Ok(candidate)) =
                    (values[1].get::<u32>(), values[2].get::<String>())
            {
                let candidate = Candidate {
                    candidate,
                    mline_index: index,
                    mid: None,
                };
                if validate_candidate(&candidate).is_ok() {
                    inner.push(Event::Candidate(candidate));
                } else {
                    inner.fail(Error("Local ICE candidate exceeds the client limit"));
                }
            }
            None
        });
        let weak = Arc::downgrade(inner);
        inner
            .rtc
            .connect_notify(Some("connection-state"), move |rtc, _| {
                if let Some(inner) = live(&weak) {
                    let state = match rtc.property::<WebRTCPeerConnectionState>("connection-state")
                    {
                        WebRTCPeerConnectionState::New => ConnectionState::New,
                        WebRTCPeerConnectionState::Connecting => ConnectionState::Connecting,
                        WebRTCPeerConnectionState::Connected => ConnectionState::Connected,
                        WebRTCPeerConnectionState::Disconnected => ConnectionState::Disconnected,
                        WebRTCPeerConnectionState::Failed => {
                            inner.inbox.lock().unwrap().network_lost();
                            return;
                        }
                        _ => ConnectionState::Closed,
                    };
                    inner.push(Event::Connection(state));
                }
            });
        let weak = Arc::downgrade(inner);
        inner.rtc.connect("on-data-channel", false, move |values| {
            if let Some(inner) = live(&weak)
                && let Ok(channel) = values[1].get::<WebRTCDataChannel>()
            {
                Self::install_channel(&inner, channel);
            }
            None
        });
        let weak = Arc::downgrade(inner);
        inner.rtc.connect_pad_added(move |_, pad| {
            if pad.direction() != gst::PadDirection::Src {
                return;
            }
            if let Some(inner) = live(&weak)
                && let Err(error) = Self::add_decoder(&inner, pad)
            {
                inner.fail(error);
            }
        });
    }

    fn install_channel(inner: &Arc<Self>, channel: WebRTCDataChannel) {
        if channel.label().as_deref() != Some("rtc") {
            channel.close();
            inner.fail(Error("Unexpected WebRTC control channel"));
            return;
        }
        {
            let mut slot = inner.channel.lock().unwrap();
            if slot.is_some() {
                channel.close();
                inner.fail(Error("Duplicate WebRTC control channel"));
                return;
            }
            *slot = Some(channel.clone());
        }
        let weak = Arc::downgrade(inner);
        channel.connect_on_open(move |_| {
            if let Some(inner) = live(&weak) {
                inner.push(Event::ControlOpened);
            }
        });
        let weak = Arc::downgrade(inner);
        channel.connect_on_close(move |_| {
            if let Some(inner) = live(&weak) {
                inner.push(Event::ControlClosed);
            }
        });
        let weak = Arc::downgrade(inner);
        channel.connect_on_error(move |_, _| {
            if let Some(inner) = live(&weak) {
                inner.fail(Error("WebRTC control channel failed"));
            }
        });
        let weak = Arc::downgrade(inner);
        channel.connect_on_message_data(move |_, bytes| {
            if let Some(inner) = live(&weak)
                && let Some(bytes) = bytes
            {
                if bytes.len() > MAX_CONTROL_BYTES {
                    inner.fail(Error("Control message exceeds the client limit"));
                } else {
                    inner.push(Event::ControlData(bytes.as_ref().to_vec()));
                }
            }
        });
        let weak = Arc::downgrade(inner);
        channel.connect_on_message_string(move |_, _| {
            if let Some(inner) = live(&weak) {
                inner.fail(Error("Unexpected text control message"));
            }
        });
    }

    fn create_description(inner: &Arc<Self>, kind: SdpKind) {
        if kind == SdpKind::Offer {
            let mut negotiation = inner.negotiation.lock().unwrap();
            if negotiation.making_offer
                || negotiation.setting_remote
                || inner
                    .rtc
                    .property::<WebRTCSignalingState>("signaling-state")
                    != WebRTCSignalingState::Stable
            {
                return;
            }
            negotiation.making_offer = true;
        }
        let weak = Arc::downgrade(inner);
        let promise = gst::Promise::with_change_func(move |reply| {
            let Some(inner) = live(&weak) else {
                return;
            };
            let description = reply.ok().flatten().and_then(|reply| {
                reply
                    .get::<WebRTCSessionDescription>(if kind == SdpKind::Offer {
                        "offer"
                    } else {
                        "answer"
                    })
                    .ok()
            });
            let Some(mut description) = description else {
                inner.fail(Error("Could not create local SDP"));
                return;
            };
            if kind == SdpKind::Answer
                && let Err(error) = inner.preserve_established_dtls_role(&mut description)
            {
                inner.fail(error);
                return;
            }
            let Ok(sdp) = description.sdp().as_text() else {
                inner.fail(Error("Could not serialize local SDP"));
                return;
            };
            if sdp.len() > MAX_SDP_BYTES {
                inner.fail(Error("Local SDP exceeds the client limit"));
                return;
            }
            let weak = Arc::downgrade(&inner);
            let promise = gst::Promise::with_change_func(move |reply| {
                let Some(inner) = live(&weak) else {
                    return;
                };
                if !promise_ok(&reply) {
                    inner.fail(Error("Could not apply local SDP"));
                    return;
                }
                inner.negotiation.lock().unwrap().making_offer = false;
                inner.push(Event::Description(Description { kind, sdp }));
            });
            inner
                .rtc
                .emit_by_name::<()>("set-local-description", &[&description, &promise]);
        });
        inner.rtc.emit_by_name::<()>(
            if kind == SdpKind::Offer {
                "create-offer"
            } else {
                "create-answer"
            },
            &[&None::<gst::Structure>, &promise],
        );
    }

    fn preserve_established_dtls_role(
        &self,
        answer: &mut WebRTCSessionDescription,
    ) -> Result<(), Error> {
        let Some(transport) = self
            .rtc
            .property::<Option<gst_webrtc::WebRTCSCTPTransport>>("sctp-transport")
            .and_then(|sctp| sctp.transport())
            .filter(|dtls| dtls.state() == gst_webrtc::WebRTCDTLSTransportState::Connected)
        else {
            return Ok(());
        };
        let offer = self
            .rtc
            .property::<Option<WebRTCSessionDescription>>("pending-remote-description")
            .ok_or(Error("Media answer has no pending offer"))?;
        // GStreamer 1.28 answers actpass with active even when the bundled
        // control transport is already the DTLS server. Chrome rejects that role change.
        preserve_answer_role(
            answer.sdp_mut(),
            offer.sdp(),
            transport.session_id(),
            transport.is_client(),
        )
    }

    fn add_candidate_now(&self, candidate: Candidate) {
        self.rtc.emit_by_name::<()>(
            "add-ice-candidate",
            &[&candidate.mline_index, &candidate.candidate],
        );
    }

    fn add_decoder(inner: &Arc<Self>, pad: &gst::Pad) -> Result<(), Error> {
        if inner.tracks.fetch_add(1, Ordering::AcqRel) >= MAX_TRACKS {
            return Err(Error("Remote peer exceeded the media track limit"));
        }
        let decoder = element("decodebin")?;
        let weak = Arc::downgrade(inner);
        decoder.connect_pad_added(move |_, pad| {
            if let Some(inner) = live(&weak)
                && let Err(error) = Self::add_output(&inner, pad)
            {
                inner.fail(error);
            }
        });
        inner
            .pipeline
            .add(&decoder)
            .map_err(|_| Error("Could not add a media decoder"))?;
        decoder
            .sync_state_with_parent()
            .map_err(|_| Error("Could not start a media decoder"))?;
        pad.link(
            &decoder
                .static_pad("sink")
                .ok_or(Error("Decoder has no input"))?,
        )
        .map_err(|_| Error("Could not link incoming media"))?;
        Ok(())
    }

    fn add_output(inner: &Arc<Self>, pad: &gst::Pad) -> Result<(), Error> {
        let caps = pad
            .current_caps()
            .ok_or(Error("Decoded media has no format"))?;
        let name = caps
            .structure(0)
            .ok_or(Error("Decoded media has no format"))?
            .name();
        if name == "video/x-raw" {
            Self::add_video(inner, pad)
        } else if name == "audio/x-raw" {
            Self::add_audio(inner, pad)
        } else {
            Err(Error("Unsupported decoded media type"))
        }
    }

    fn add_video(inner: &Arc<Self>, pad: &gst::Pad) -> Result<(), Error> {
        let convert = element("videoconvert")?;
        let sink = gst_app::AppSink::builder()
            .caps(
                &gst::Caps::builder("video/x-raw")
                    .field("format", "RGBA")
                    .build(),
            )
            .max_buffers(1)
            .drop(true)
            .sync(false)
            .build();
        let weak = Arc::downgrade(inner);
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let Some(inner) = live(&weak) else {
                        return Err(gst::FlowError::Flushing);
                    };
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    match copy_frame(&sample) {
                        Ok(frame) => inner.inbox.lock().unwrap().frame(frame),
                        Err(error) => {
                            inner.fail(error);
                            return Err(gst::FlowError::Error);
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let sink: gst::Element = sink.upcast();
        inner
            .pipeline
            .add_many([&convert, &sink])
            .map_err(|_| Error("Could not add video output"))?;
        convert
            .link(&sink)
            .map_err(|_| Error("Could not link video output"))?;
        sink.sync_state_with_parent()
            .map_err(|_| Error("Could not start video output"))?;
        convert
            .sync_state_with_parent()
            .map_err(|_| Error("Could not start video conversion"))?;
        pad.link(
            &convert
                .static_pad("sink")
                .ok_or(Error("Video converter has no input"))?,
        )
        .map_err(|_| Error("Could not link decoded video"))?;
        Ok(())
    }

    fn add_audio(inner: &Arc<Self>, pad: &gst::Pad) -> Result<(), Error> {
        let convert = element("audioconvert")?;
        let resample = element("audioresample")?;
        let volume = element("volume")?;
        let sink_name = "autoaudiosink";
        #[cfg(test)]
        let sink_name = if inner.silent_audio_sink.load(Ordering::Acquire) {
            "fakesink"
        } else {
            sink_name
        };
        let sink = element(sink_name)?;
        {
            let mut volumes = inner.volume.lock().unwrap();
            if volumes.len() >= MAX_TRACKS {
                return Err(Error("Too many decoded audio outputs"));
            }
            volume.set_property("mute", !inner.audio_enabled.load(Ordering::Acquire));
            volumes.push(volume.clone());
        }
        let weak = Arc::downgrade(inner);
        pad.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
            if let Some(inner) = live(&weak)
                && let (Some(buffer), Some(caps)) = (info.buffer(), pad.current_caps())
                && let Some(format) = caps.structure(0)
            {
                let rate = format.get::<i32>("rate").unwrap_or(0);
                if (1..=384_000).contains(&rate)
                    && let Some(duration) = buffer.duration()
                {
                    let samples = duration.nseconds().saturating_mul(rate as u64) / 1_000_000_000;
                    inner.inbox.lock().unwrap().audio(samples);
                }
            }
            gst::PadProbeReturn::Ok
        });
        let elements = [&convert, &resample, &volume, &sink];
        inner
            .pipeline
            .add_many(elements)
            .map_err(|_| Error("Could not add audio output"))?;
        gst::Element::link_many(elements).map_err(|_| Error("Could not link audio output"))?;
        for element in elements.into_iter().rev() {
            element
                .sync_state_with_parent()
                .map_err(|_| Error("Could not start audio output"))?;
        }
        pad.link(
            &convert
                .static_pad("sink")
                .ok_or(Error("Audio converter has no input"))?,
        )
        .map_err(|_| Error("Could not link decoded audio"))?;
        Ok(())
    }
}

fn missing_decoder(structure: &gst::StructureRef) -> Option<&'static str> {
    if structure.name() != "missing-plugin" || structure.get::<&str>("type").ok()? != "decoder" {
        return None;
    }
    let caps = structure.get::<gst::Caps>("detail").ok()?;
    // Caps can contain remote data. Return only fixed descriptions, never their values.
    Some(match caps.structure(0)?.name().as_str() {
        "application/x-rtp" => "The negotiated RTP format has no compatible GStreamer depayloader",
        "video/x-h264" => {
            "A decoder for the host's H.264 profile is missing; install GStreamer's libav plugin"
        }
        "video/x-h265" => "An H.265 decoder is missing; install GStreamer's libav plugin",
        "video/x-vp8" => "A VP8 decoder is missing; install GStreamer's VPX plugin",
        "video/x-vp9" => "A VP9 decoder is missing; install GStreamer's VPX plugin",
        "video/x-av1" => "An AV1 decoder is missing; install a GStreamer AV1 decoder plugin",
        "audio/x-opus" => "An Opus decoder is missing; install GStreamer's Opus plugin",
        _ => {
            "A decoder for the host's media format is missing; check the native runtime dependencies"
        }
    })
}

fn receive_codecs() -> gst::Caps {
    let mut caps = gst::Caps::new_empty();
    for (media, name, rate, required) in [
        ("video", "VP8", 90_000, &["rtpvp8depay", "vp8dec"][..]),
        ("video", "VP9", 90_000, &["rtpvp9depay", "vp9dec"][..]),
        (
            "video",
            "H264",
            90_000,
            &["rtph264depay", "h264parse", "avdec_h264"][..],
        ),
        ("audio", "OPUS", 48_000, &["rtpopusdepay", "opusdec"][..]),
    ] {
        if required
            .iter()
            .all(|name| gst::ElementFactory::find(name).is_some())
        {
            caps.get_mut().unwrap().append_structure(
                gst::Structure::builder("application/x-rtp")
                    .field("media", media)
                    .field("encoding-name", name)
                    .field("clock-rate", rate)
                    .build(),
            );
        }
    }
    caps
}

fn preserve_answer_role(
    answer: &mut gst_sdp::SDPMessageRef,
    offer: &gst_sdp::SDPMessageRef,
    transport_index: u32,
    client: bool,
) -> Result<(), Error> {
    let transport_mid = answer
        .media(transport_index)
        .and_then(|media| media.attribute_val("mid"))
        .ok_or(Error("Established DTLS transport has no media identifier"))?;
    let bundle: Vec<String> = answer
        .attributes()
        .filter(|attribute| attribute.key() == "group")
        .filter_map(|attribute| attribute.value())
        .filter_map(|value| value.strip_prefix("BUNDLE "))
        .find(|value| value.split_whitespace().any(|mid| mid == transport_mid))
        .map(|value| value.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default();
    let local_setup = if client { "active" } else { "passive" };
    let remote_setup = if client { "passive" } else { "active" };
    for (index, media) in answer.medias_mut().enumerate() {
        let bundled = media
            .attribute_val("mid")
            .is_some_and(|mid| bundle.iter().any(|id| id == mid));
        if media.port() == 0 || (index != transport_index as usize && !bundled) {
            continue;
        }
        let remote = offer
            .media(index as u32)
            .ok_or(Error("Media answer has no matching offer section"))?;
        if remote.attribute_val("mid") != media.attribute_val("mid") {
            return Err(Error("Media identifiers changed during DTLS negotiation"));
        }
        let setup = remote
            .attribute_val("setup")
            .or_else(|| offer.attribute_val("setup"));
        if setup != Some("actpass") && setup != Some(remote_setup) {
            return Err(Error(
                "The host requested a conflicting established DTLS role",
            ));
        }
        let attribute = media
            .attributes()
            .position(|attribute| attribute.key() == "setup");
        if let Some(index) = attribute {
            media
                .replace_attribute(
                    index as u32,
                    gst_sdp::SDPAttribute::new("setup", Some(local_setup)),
                )
                .map_err(|_| Error("Could not preserve the established DTLS role"))?;
        } else {
            media.add_attribute("setup", Some(local_setup));
        }
    }
    Ok(())
}

fn live(weak: &Weak<Inner>) -> Option<Arc<Inner>> {
    weak.upgrade()
        .filter(|inner| inner.alive.load(Ordering::Acquire) && !inner.inbox.lock().unwrap().ended())
}

fn element(name: &'static str) -> Result<gst::Element, Error> {
    gst::ElementFactory::make(name)
        .build()
        .map_err(|_| Error("A required GStreamer plugin is unavailable"))
}

fn promise_ok(reply: &Result<Option<&gst::StructureRef>, gst::PromiseError>) -> bool {
    matches!(reply, Ok(None)) || matches!(reply, Ok(Some(reply)) if !reply.has_field("error"))
}

fn copy_frame(sample: &gst::Sample) -> Result<VideoFrame, Error> {
    let caps = sample.caps().ok_or(Error("Video sample has no format"))?;
    let info =
        gst_video::VideoInfo::from_caps(caps).map_err(|_| Error("Invalid video sample format"))?;
    let length = frame_bytes(info.width(), info.height())?;
    if info.format() != gst_video::VideoFormat::Rgba {
        return Err(Error("Expected RGBA video"));
    }
    let buffer = sample.buffer().ok_or(Error("Video sample has no buffer"))?;
    let frame = gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info)
        .map_err(|_| Error("Could not map decoded video"))?;
    let plane = frame
        .plane_data(0)
        .map_err(|_| Error("Could not read decoded video"))?;
    let stride =
        usize::try_from(frame.plane_stride()[0]).map_err(|_| Error("Invalid video stride"))?;
    let row_bytes = info.width() as usize * 4;
    let height = info.height() as usize;
    if stride < row_bytes
        || stride
            .checked_mul(height - 1)
            .and_then(|v| v.checked_add(row_bytes))
            .is_none_or(|required| required > plane.len())
    {
        return Err(Error("Decoded video buffer is truncated"));
    }
    let mut rgba = Vec::with_capacity(length);
    for row in 0..height {
        rgba.extend_from_slice(&plane[row * stride..row * stride + row_bytes]);
    }
    Ok(VideoFrame {
        width: info.width(),
        height: info.height(),
        rgba,
    })
}

fn ice_uri(server: &IceServer) -> Result<(bool, String), Error> {
    if server.uri.len() > 4096
        || server.username.as_ref().is_some_and(|v| v.len() > 4096)
        || server.password.as_ref().is_some_and(|v| v.len() > 4096)
    {
        return Err(Error("ICE server exceeds the client limit"));
    }
    let (scheme, rest) = server
        .uri
        .split_once(':')
        .ok_or(Error("Invalid ICE server URI"))?;
    if !matches!(scheme, "stun" | "turn" | "turns") {
        return Err(Error("Unsupported ICE server scheme"));
    }
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let (host, query) = rest
        .split_once('?')
        .map_or((rest, None), |(h, q)| (h, Some(q)));
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '@' | '/' | '#' | '%' | '\\'))
    {
        return Err(Error("Invalid ICE server address"));
    }
    if let Some(query) = query
        && !matches!(query, "transport=udp" | "transport=tcp")
    {
        return Err(Error("Unsupported ICE transport"));
    }
    if scheme == "stun" {
        return Ok((false, format!("stun://{host}")));
    }
    let user = server
        .username
        .as_deref()
        .ok_or(Error("TURN credentials are missing"))?;
    let password = server
        .password
        .as_deref()
        .ok_or(Error("TURN credentials are missing"))?;
    let mut uri = format!(
        "{scheme}://{}:{}@{host}",
        escape_userinfo(user),
        escape_userinfo(password)
    );
    if let Some(query) = query {
        uri.push('?');
        uri.push_str(query);
    }
    Ok((true, uri))
}

fn escape_userinfo(value: &str) -> String {
    use std::fmt::Write;
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            write!(output, "%{byte:02X}").expect("Writing to String cannot fail");
        }
    }
    output
}

#[cfg(test)]
mod tests;
