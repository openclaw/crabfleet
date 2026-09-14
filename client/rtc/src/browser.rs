use crate::{
    Candidate, ConnectionState, Description, Error, Event, MAX_BUFFERED_BYTES, MAX_CONTROL_BYTES,
    MAX_SDP_BYTES, Options, SdpKind, Updates, VideoFrame, frame_bytes, inbox::Inbox,
    validate_candidate,
};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    CanvasRenderingContext2d, HtmlAudioElement, HtmlCanvasElement, HtmlVideoElement, MediaStream,
    RtcConfiguration, RtcDataChannel, RtcDataChannelEvent, RtcDataChannelState, RtcDataChannelType,
    RtcIceCandidateInit, RtcIceServer, RtcPeerConnection, RtcPeerConnectionIceEvent,
    RtcPeerConnectionState, RtcSdpType, RtcSessionDescriptionInit, RtcSignalingState,
    RtcTrackEvent,
};

const MAX_PENDING_CANDIDATES: usize = 128;
const CONTROL_CHUNK: usize = 16 * 1024;
type Handler = Closure<dyn FnMut(web_sys::Event)>;
type FrameHandler = Closure<dyn FnMut(f64, JsValue)>;

struct Inner {
    rtc: RtcPeerConnection,
    channel: RefCell<Option<RtcDataChannel>>,
    inbox: RefCell<Inbox>,
    alive: Cell<bool>,
    started: Cell<bool>,
    making_offer: Cell<bool>,
    setting_remote: Cell<bool>,
    remote_ready: Cell<bool>,
    ignore_offer: Cell<bool>,
    pending_candidates: RefCell<Vec<Candidate>>,
    ice_inflight: Cell<usize>,
    handlers: RefCell<Vec<Handler>>,
    video: HtmlVideoElement,
    audio: HtmlAudioElement,
    canvas: HtmlCanvasElement,
    context: CanvasRenderingContext2d,
    video_stream: RefCell<Option<MediaStream>>,
    audio_stream: RefCell<Option<MediaStream>>,
    video_frame_ready: Cell<bool>,
    video_frame_request: Cell<Option<u32>>,
    video_frame_handler: RefCell<Option<FrameHandler>>,
    request_video_frame: js_sys::Function,
    cancel_video_frame: js_sys::Function,
    video_generation: Cell<u64>,
    audio_generation: Cell<u64>,
}

/// Browser media and transport. `poll` copies video only when the browser
/// reports a new decoded frame. Signaling delivery belongs to the caller.
pub struct Peer {
    inner: Rc<Inner>,
}

impl Peer {
    pub fn new(options: Options) -> Result<Self, Error> {
        if options.ice_servers.len() > 32 {
            return Err(Error("Too many ICE servers"));
        }
        let config = RtcConfiguration::new();
        config.set_bundle_policy(web_sys::RtcBundlePolicy::MaxBundle);
        let servers = js_sys::Array::new();
        for server in options.ice_servers {
            if server.uri.len() > 4096
                || server.username.as_ref().is_some_and(|s| s.len() > 4096)
                || server.password.as_ref().is_some_and(|s| s.len() > 4096)
            {
                return Err(Error("ICE server exceeds the client limit"));
            }
            let item = RtcIceServer::new();
            item.set_urls_str(browser_ice_uri(&server.uri));
            if let Some(username) = server.username {
                item.set_username(&username);
            }
            if let Some(password) = server.password {
                item.set_credential(&password);
            }
            servers.push(&item);
        }
        config.set_ice_servers(&servers);
        let document = web_sys::window()
            .and_then(|window| window.document())
            .ok_or(Error("Browser document is unavailable"))?;
        let video: HtmlVideoElement = document
            .create_element("video")
            .map_err(|_| Error("Could not create video output"))?
            .dyn_into()
            .map_err(|_| Error("Video output is unavailable"))?;
        video.set_muted(true);
        video.set_autoplay(true);
        video
            .set_attribute("playsinline", "")
            .map_err(|_| Error("Could not initialize video output"))?;
        let request_video_frame = video_method(&video, "requestVideoFrameCallback")?;
        let cancel_video_frame = video_method(&video, "cancelVideoFrameCallback")?;
        let audio = HtmlAudioElement::new().map_err(|_| Error("Could not create audio output"))?;
        audio.set_muted(!options.audio_enabled);
        audio.set_autoplay(true);
        let canvas: HtmlCanvasElement = document
            .create_element("canvas")
            .map_err(|_| Error("Could not create video canvas"))?
            .dyn_into()
            .map_err(|_| Error("Video canvas is unavailable"))?;
        let context: CanvasRenderingContext2d = canvas
            .get_context("2d")
            .map_err(|_| Error("Video canvas is unavailable"))?
            .ok_or(Error("Video canvas is unavailable"))?
            .dyn_into()
            .map_err(|_| Error("Video canvas is unavailable"))?;
        let rtc = RtcPeerConnection::new_with_configuration(&config)
            .map_err(|_| Error("Could not create WebRTC peer"))?;
        let inner = Rc::new(Inner {
            rtc,
            channel: RefCell::new(None),
            inbox: RefCell::new(Inbox::default()),
            alive: Cell::new(true),
            started: Cell::new(false),
            making_offer: Cell::new(false),
            setting_remote: Cell::new(false),
            remote_ready: Cell::new(false),
            ignore_offer: Cell::new(false),
            pending_candidates: RefCell::new(Vec::new()),
            ice_inflight: Cell::new(0),
            handlers: RefCell::new(Vec::new()),
            video,
            audio,
            canvas,
            context,
            video_stream: RefCell::new(None),
            audio_stream: RefCell::new(None),
            video_frame_ready: Cell::new(false),
            video_frame_request: Cell::new(None),
            video_frame_handler: RefCell::new(None),
            request_video_frame,
            cancel_video_frame,
            video_generation: Cell::new(0),
            audio_generation: Cell::new(0),
        });
        let weak = Rc::downgrade(&inner);
        *inner.video_frame_handler.borrow_mut() = Some(Closure::new(move |_, _| {
            if let Some(inner) = live(&weak) {
                inner.video_frame_request.set(None);
                inner.video_frame_ready.set(true);
            }
        }));
        Inner::install(&inner);
        Ok(Self { inner })
    }

    pub fn start(&mut self) -> Result<(), Error> {
        self.ensure_live()?;
        if self.inner.started.replace(true) {
            return Err(Error("WebRTC peer has already started"));
        }
        Inner::install_channel(&self.inner, self.inner.rtc.create_data_channel("rtc"));
        Ok(())
    }

    pub fn set_remote_description(&mut self, description: Description) -> Result<(), Error> {
        self.ensure_live()?;
        if description.sdp.is_empty() || description.sdp.len() > MAX_SDP_BYTES {
            return Err(Error("Invalid SDP size"));
        }
        if description
            .sdp
            .lines()
            .filter(|line| line.starts_with("m="))
            .count()
            > 9
        {
            return Err(Error("Remote SDP has too many media sections"));
        }
        let offer = description.kind == SdpKind::Offer;
        if offer
            && (self.inner.making_offer.get()
                || self.inner.rtc.signaling_state() != RtcSignalingState::Stable)
        {
            self.inner.ignore_offer.set(true);
            return Ok(());
        }
        if self.inner.setting_remote.replace(true) {
            return Err(Error("Remote SDP operation is already pending"));
        }
        self.inner.ignore_offer.set(false);
        self.inner.remote_ready.set(false);
        let promise = self
            .inner
            .rtc
            .set_remote_description(&to_js_description(&description));
        let weak = Rc::downgrade(&self.inner);
        spawn_local(async move {
            let result = JsFuture::from(promise).await;
            let Some(inner) = live(&weak) else {
                return;
            };
            inner.setting_remote.set(false);
            if result.is_err() {
                inner.fail(Error("Could not apply remote SDP"));
                return;
            }
            inner.remote_ready.set(true);
            let pending = std::mem::take(&mut *inner.pending_candidates.borrow_mut());
            for candidate in pending {
                Inner::add_candidate_now(&inner, candidate);
            }
            if offer {
                Inner::create_description(&inner, SdpKind::Answer);
            }
        });
        Ok(())
    }

    pub fn add_candidate(&mut self, candidate: Candidate) -> Result<(), Error> {
        self.ensure_live()?;
        validate_candidate(&candidate)?;
        if self.inner.ignore_offer.get() {
            return Ok(());
        }
        if !self.inner.remote_ready.get() {
            let mut pending = self.inner.pending_candidates.borrow_mut();
            if pending.len() >= MAX_PENDING_CANDIDATES {
                return Err(Error("Too many pending ICE candidates"));
            }
            pending.push(candidate);
        } else {
            Inner::add_candidate_now(&self.inner, candidate);
        }
        Ok(())
    }

    pub fn send_control(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.ensure_live()?;
        if bytes.is_empty() || bytes.len() > MAX_CONTROL_BYTES {
            return Err(Error("Invalid control message size"));
        }
        let channel = self
            .inner
            .channel
            .borrow()
            .clone()
            .ok_or(Error("Control channel is not available"))?;
        if channel.ready_state() != RtcDataChannelState::Open {
            return Err(Error("Control channel is not open"));
        }
        if (channel.buffered_amount() as usize).saturating_add(bytes.len()) > MAX_BUFFERED_BYTES {
            self.inner
                .fail(Error("Control channel write queue exceeded its limit"));
            return Err(Error("Control channel write queue exceeded its limit"));
        }
        for chunk in bytes.chunks(CONTROL_CHUNK) {
            if channel.send_with_u8_array(chunk).is_err() {
                self.inner.fail(Error("Control channel write failed"));
                return Err(Error("Control channel write failed"));
            }
        }
        Ok(())
    }

    /// Call from a user gesture to satisfy browser audio playback policy.
    pub fn set_audio_enabled(&mut self, enabled: bool) -> Result<(), Error> {
        self.ensure_live()?;
        self.inner.audio.set_muted(!enabled);
        if enabled {
            play(&self.inner.audio, &Rc::downgrade(&self.inner), false);
        }
        Ok(())
    }

    pub fn poll(&mut self) -> Updates {
        if self.inner.alive.get()
            && !self.inner.inbox.borrow().ended()
            && let Err(error) = self
                .inner
                .copy_video()
                .and_then(|()| self.inner.arm_video_frame())
        {
            self.inner.fail(error);
        }
        let ended = self.inner.inbox.borrow().ended();
        let updates = self.inner.inbox.borrow_mut().drain();
        if ended {
            self.close();
        }
        updates
    }

    pub fn close(&mut self) {
        if !self.inner.alive.replace(false) {
            return;
        }
        self.inner.inbox.borrow_mut().close();
        self.inner.rtc.set_onnegotiationneeded(None);
        self.inner.rtc.set_onicecandidate(None);
        self.inner.rtc.set_onconnectionstatechange(None);
        self.inner.rtc.set_ondatachannel(None);
        self.inner.rtc.set_ontrack(None);
        if let Some(channel) = self.inner.channel.borrow_mut().take() {
            channel.set_onopen(None);
            channel.set_onclose(None);
            channel.set_onerror(None);
            channel.set_onmessage(None);
            channel.close();
        }
        self.inner.rtc.close();
        self.inner.cancel_video_frame();
        self.inner.video_frame_handler.borrow_mut().take();
        let _ = self.inner.video.pause();
        let _ = self.inner.audio.pause();
        self.inner.video.set_src_object(None);
        self.inner.audio.set_src_object(None);
        for stream in [
            self.inner.video_stream.borrow_mut().take(),
            self.inner.audio_stream.borrow_mut().take(),
        ]
        .into_iter()
        .flatten()
        {
            stop_stream(&stream);
        }
        self.inner.canvas.set_width(0);
        self.inner.canvas.set_height(0);
        self.inner.pending_candidates.borrow_mut().clear();
        self.inner.handlers.borrow_mut().clear();
    }

    fn ensure_live(&self) -> Result<(), Error> {
        if !self.inner.alive.get() || self.inner.inbox.borrow().ended() {
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
        self.inbox.borrow_mut().push(event);
    }
    fn fail(&self, error: Error) {
        self.inbox.borrow_mut().fail(error);
    }

    fn handler(
        inner: &Rc<Self>,
        callback: impl Fn(&Rc<Self>, web_sys::Event) + 'static,
    ) -> js_sys::Function {
        let weak = Rc::downgrade(inner);
        let closure = Closure::<dyn FnMut(web_sys::Event)>::new(move |event| {
            if let Some(inner) = live(&weak) {
                callback(&inner, event);
            }
        });
        let function = closure.as_ref().unchecked_ref::<js_sys::Function>().clone();
        inner.handlers.borrow_mut().push(closure);
        function
    }

    fn install(inner: &Rc<Self>) {
        inner
            .rtc
            .set_onnegotiationneeded(Some(&Self::handler(inner, |inner, _| {
                Self::create_description(inner, SdpKind::Offer);
            })));
        inner
            .rtc
            .set_onicecandidate(Some(&Self::handler(inner, |inner, event| {
                let Ok(event) = event.dyn_into::<RtcPeerConnectionIceEvent>() else {
                    return;
                };
                let Some(candidate) = event.candidate() else {
                    return;
                };
                let Some(index) = candidate.sdp_m_line_index() else {
                    inner.fail(Error("ICE candidate has no media index"));
                    return;
                };
                let candidate = Candidate {
                    candidate: candidate.candidate(),
                    mline_index: index as u32,
                    mid: candidate.sdp_mid(),
                };
                if validate_candidate(&candidate).is_ok() {
                    inner.push(Event::Candidate(candidate));
                } else {
                    inner.fail(Error("Local ICE candidate exceeds the client limit"));
                }
            })));
        inner
            .rtc
            .set_onconnectionstatechange(Some(&Self::handler(inner, |inner, _| {
                let state = match inner.rtc.connection_state() {
                    RtcPeerConnectionState::New => ConnectionState::New,
                    RtcPeerConnectionState::Connecting => ConnectionState::Connecting,
                    RtcPeerConnectionState::Connected => ConnectionState::Connected,
                    RtcPeerConnectionState::Disconnected => ConnectionState::Disconnected,
                    RtcPeerConnectionState::Failed => {
                        inner.inbox.borrow_mut().network_lost();
                        return;
                    }
                    _ => ConnectionState::Closed,
                };
                inner.push(Event::Connection(state));
            })));
        inner
            .rtc
            .set_ondatachannel(Some(&Self::handler(inner, |inner, event| {
                if let Ok(event) = event.dyn_into::<RtcDataChannelEvent>() {
                    Self::install_channel(inner, event.channel());
                }
            })));
        inner
            .rtc
            .set_ontrack(Some(&Self::handler(inner, |inner, event| {
                if let Ok(event) = event.dyn_into::<RtcTrackEvent>()
                    && let Err(error) = Self::add_track(inner, event)
                {
                    inner.fail(error);
                }
            })));
    }

    fn install_channel(inner: &Rc<Self>, channel: RtcDataChannel) {
        if channel.label() != "rtc" || inner.channel.borrow().is_some() {
            channel.close();
            inner.fail(Error("Unexpected or duplicate WebRTC control channel"));
            return;
        }
        channel.set_binary_type(RtcDataChannelType::Arraybuffer);
        channel.set_onopen(Some(&Self::handler(inner, |inner, _| {
            inner.push(Event::ControlOpened);
        })));
        channel.set_onclose(Some(&Self::handler(inner, |inner, _| {
            inner.push(Event::ControlClosed);
        })));
        channel.set_onerror(Some(&Self::handler(inner, |inner, _| {
            inner.fail(Error("WebRTC control channel failed"));
        })));
        channel.set_onmessage(Some(&Self::handler(inner, |inner, event| {
            let Ok(event) = event.dyn_into::<web_sys::MessageEvent>() else {
                return;
            };
            let Ok(buffer) = event.data().dyn_into::<js_sys::ArrayBuffer>() else {
                inner.fail(Error("Unexpected nonbinary control message"));
                return;
            };
            if buffer.byte_length() as usize > MAX_CONTROL_BYTES {
                inner.fail(Error("Control message exceeds the client limit"));
                return;
            }
            inner.push(Event::ControlData(
                js_sys::Uint8Array::new(&buffer).to_vec(),
            ));
        })));
        *inner.channel.borrow_mut() = Some(channel);
    }

    fn create_description(inner: &Rc<Self>, kind: SdpKind) {
        if kind == SdpKind::Offer {
            if inner.making_offer.get()
                || inner.setting_remote.get()
                || inner.rtc.signaling_state() != RtcSignalingState::Stable
            {
                return;
            }
            inner.making_offer.set(true);
        }
        let promise = if kind == SdpKind::Offer {
            inner.rtc.create_offer()
        } else {
            inner.rtc.create_answer()
        };
        let weak = Rc::downgrade(inner);
        spawn_local(async move {
            let result = JsFuture::from(promise).await;
            let Some(inner) = live(&weak) else {
                return;
            };
            let sdp = result
                .ok()
                .and_then(|value| js_sys::Reflect::get(&value, &JsValue::from_str("sdp")).ok())
                .and_then(|value| value.as_string());
            let Some(sdp) = sdp.filter(|sdp| !sdp.is_empty() && sdp.len() <= MAX_SDP_BYTES) else {
                inner.fail(Error("Could not create local SDP"));
                return;
            };
            let description = Description { kind, sdp };
            let promise = inner
                .rtc
                .set_local_description(&to_js_description(&description));
            drop(inner);
            let result = JsFuture::from(promise).await;
            let Some(inner) = live(&weak) else {
                return;
            };
            inner.making_offer.set(false);
            if result.is_err() {
                inner.fail(Error("Could not apply local SDP"));
                return;
            }
            inner.push(Event::Description(description));
        });
    }

    fn add_candidate_now(inner: &Rc<Self>, candidate: Candidate) {
        if inner.ice_inflight.get() >= MAX_PENDING_CANDIDATES {
            inner.fail(Error("Too many pending ICE operations"));
            return;
        }
        let item = RtcIceCandidateInit::new(&candidate.candidate);
        item.set_sdp_m_line_index(Some(candidate.mline_index as u16));
        item.set_sdp_mid(candidate.mid.as_deref());
        inner.ice_inflight.set(inner.ice_inflight.get() + 1);
        let promise = inner
            .rtc
            .add_ice_candidate_with_opt_rtc_ice_candidate_init(Some(&item));
        let weak = Rc::downgrade(inner);
        spawn_local(async move {
            let result = JsFuture::from(promise).await;
            if let Some(inner) = live(&weak) {
                inner
                    .ice_inflight
                    .set(inner.ice_inflight.get().saturating_sub(1));
                if result.is_err() && !inner.ignore_offer.get() {
                    inner.fail(Error("Could not apply ICE candidate"));
                }
            }
        });
    }

    fn add_track(inner: &Rc<Self>, event: RtcTrackEvent) -> Result<(), Error> {
        let track = event.track();
        let stream = MediaStream::new().map_err(|_| Error("Could not create media stream"))?;
        stream.add_track(&track);
        match track.kind().as_str() {
            "video" => {
                inner.cancel_video_frame();
                inner
                    .video_generation
                    .set(inner.video_generation.get().wrapping_add(1));
                if let Some(previous) = inner.video_stream.borrow_mut().replace(stream.clone()) {
                    stop_stream(&previous);
                }
                inner.video.set_src_object(Some(&stream));
                inner.arm_video_frame()?;
                play(&inner.video, &Rc::downgrade(inner), true);
            }
            "audio" => {
                inner
                    .audio_generation
                    .set(inner.audio_generation.get().wrapping_add(1));
                if let Some(previous) = inner.audio_stream.borrow_mut().replace(stream.clone()) {
                    stop_stream(&previous);
                }
                inner.audio.set_src_object(Some(&stream));
                play(&inner.audio, &Rc::downgrade(inner), false);
            }
            _ => {
                track.stop();
                return Err(Error("Unsupported remote media track"));
            }
        }
        Ok(())
    }

    fn arm_video_frame(&self) -> Result<(), Error> {
        if self.video_stream.borrow().is_none() || self.video_frame_request.get().is_some() {
            return Ok(());
        }
        let handler = self.video_frame_handler.borrow();
        let callback = handler
            .as_ref()
            .ok_or(Error("Video frame observer is unavailable"))?;
        let id = self
            .request_video_frame
            .call1(&self.video, callback.as_ref())
            .ok()
            .and_then(|value| value.as_f64())
            .filter(|id| {
                id.is_finite() && *id >= 0.0 && *id <= u32::MAX as f64 && id.fract() == 0.0
            })
            .ok_or(Error("Could not observe browser video frames"))?;
        self.video_frame_request.set(Some(id as u32));
        Ok(())
    }

    fn cancel_video_frame(&self) {
        if let Some(id) = self.video_frame_request.take() {
            let _ = self
                .cancel_video_frame
                .call1(&self.video, &JsValue::from(id));
        }
        self.video_frame_ready.set(false);
    }

    fn copy_video(&self) -> Result<(), Error> {
        // Firefox reports zero playback-quality frames for live MediaStreams.
        if !self.video_frame_ready.get() || self.video.ready_state() < 2 {
            return Ok(());
        }
        let (width, height) = (self.video.video_width(), self.video.video_height());
        let bytes = frame_bytes(width, height)?;
        if self.canvas.width() != width {
            self.canvas.set_width(width);
        }
        if self.canvas.height() != height {
            self.canvas.set_height(height);
        }
        self.context
            .draw_image_with_html_video_element(&self.video, 0.0, 0.0)
            .map_err(|_| Error("Could not draw browser video"))?;
        let image = self
            .context
            .get_image_data(0.0, 0.0, width as f64, height as f64)
            .map_err(|_| Error("Could not read browser video"))?;
        let rgba = image.data().0;
        if rgba.len() != bytes {
            return Err(Error("Browser returned an invalid video buffer"));
        }
        self.video_frame_ready.set(false);
        self.inbox.borrow_mut().frame(VideoFrame {
            width,
            height,
            rgba,
        });
        Ok(())
    }
}

fn video_method(video: &HtmlVideoElement, name: &str) -> Result<js_sys::Function, Error> {
    js_sys::Reflect::get(video, &JsValue::from_str(name))
        .ok()
        .and_then(|value| value.dyn_into().ok())
        .ok_or(Error("Browser video frame callbacks are unavailable"))
}

fn browser_ice_uri(uri: &str) -> &str {
    // The service adds a UDP hint, but browser STUN URLs cannot have a query.
    if uri.starts_with("stun:") {
        uri.strip_suffix("?transport=udp").unwrap_or(uri)
    } else {
        uri
    }
}

fn to_js_description(description: &Description) -> RtcSessionDescriptionInit {
    let item = RtcSessionDescriptionInit::new(match description.kind {
        SdpKind::Offer => RtcSdpType::Offer,
        SdpKind::Answer => RtcSdpType::Answer,
    });
    item.set_sdp(&description.sdp);
    item
}

fn live(weak: &Weak<Inner>) -> Option<Rc<Inner>> {
    weak.upgrade()
        .filter(|inner| inner.alive.get() && !inner.inbox.borrow().ended())
}

fn stop_stream(stream: &MediaStream) {
    for track in stream.get_tracks().iter() {
        if let Ok(track) = track.dyn_into::<web_sys::MediaStreamTrack>() {
            track.stop();
        }
    }
}

fn play(element: &web_sys::HtmlMediaElement, weak: &Weak<Inner>, video: bool) {
    let Some(inner) = live(weak) else {
        return;
    };
    let generation = if video {
        inner.video_generation.get()
    } else {
        inner.audio_generation.get()
    };
    drop(inner);
    let Ok(promise) = element.play() else {
        if let Some(inner) = live(weak) {
            inner.fail(Error("Browser media playback could not start"));
        }
        return;
    };
    let weak = weak.clone();
    spawn_local(async move {
        if JsFuture::from(promise).await.is_err()
            && let Some(inner) = live(&weak)
            && generation
                == if video {
                    inner.video_generation.get()
                } else {
                    inner.audio_generation.get()
                }
        {
            if video {
                inner.fail(Error("Browser video playback was blocked"));
            } else {
                inner.push(Event::AudioPlaybackBlocked);
            }
        }
    });
}

#[cfg(test)]
mod tests;
