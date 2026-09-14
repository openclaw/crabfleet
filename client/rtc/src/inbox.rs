use crate::{Error, Event, MAX_BUFFERED_BYTES, Updates, VideoFrame};
use std::collections::VecDeque;

const MAX_EVENTS: usize = 128;

#[derive(Default)]
pub(crate) struct Inbox {
    events: VecDeque<Event>,
    event_bytes: usize,
    frame: Option<VideoFrame>,
    audio_samples: u64,
    ended: bool,
}

impl Inbox {
    pub fn push(&mut self, event: Event) {
        if self.ended {
            return;
        }
        let bytes = match &event {
            Event::Description(d) => d.sdp.len(),
            Event::Candidate(c) => c.candidate.len() + c.mid.as_ref().map_or(0, String::len),
            Event::ControlData(b) => b.len(),
            _ => 0,
        };
        if self.events.len() >= MAX_EVENTS || bytes > MAX_BUFFERED_BYTES - self.event_bytes {
            self.fail(Error("WebRTC event queue exceeded its limit"));
            return;
        }
        self.event_bytes += bytes;
        self.events.push_back(event);
    }

    pub fn frame(&mut self, frame: VideoFrame) {
        if !self.ended {
            self.frame = Some(frame);
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn audio(&mut self, samples: u64) {
        if !self.ended {
            self.audio_samples = self.audio_samples.saturating_add(samples);
        }
    }

    pub fn fail(&mut self, error: Error) {
        if self.ended {
            return;
        }
        self.close();
        self.events.push_back(Event::Failed(error));
    }

    pub fn network_lost(&mut self) {
        // Preserve earlier host rejection/end messages so they take priority over retries.
        self.push(Event::NetworkLost);
        self.ended = true;
        self.frame = None;
    }

    pub fn close(&mut self) {
        self.ended = true;
        self.events.clear();
        self.event_bytes = 0;
        self.frame = None;
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    pub fn drain(&mut self) -> Updates {
        self.event_bytes = 0;
        Updates {
            events: self.events.drain(..).collect(),
            frame: self.frame.take(),
            audio_samples: self.audio_samples,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_loss_preserves_earlier_control_messages_and_fences_late_media() {
        let mut inbox = Inbox::default();
        inbox.push(Event::ControlData(vec![1, 2, 3]));
        inbox.network_lost();
        inbox.push(Event::ControlOpened);
        inbox.frame(VideoFrame {
            width: 1,
            height: 1,
            rgba: vec![0; 4],
        });
        let updates = inbox.drain();
        assert!(
            matches!(updates.events.as_slice(), [Event::ControlData(bytes), Event::NetworkLost] if bytes == &[1, 2, 3])
        );
        assert!(updates.frame.is_none());
        assert!(inbox.drain().events.is_empty());
    }

    #[test]
    fn overflow_fails_once_and_fences_late_callbacks() {
        let mut inbox = Inbox::default();
        inbox.push(Event::ControlData(vec![0; MAX_BUFFERED_BYTES]));
        inbox.push(Event::ControlData(vec![0]));
        inbox.push(Event::ControlOpened);
        inbox.frame(VideoFrame {
            width: 1,
            height: 1,
            rgba: vec![0; 4],
        });
        let updates = inbox.drain();
        assert!(matches!(updates.events.as_slice(), [Event::Failed(_)]));
        assert!(updates.frame.is_none());
        assert!(inbox.drain().events.is_empty());
    }

    #[test]
    fn video_replaces_instead_of_queueing() {
        let mut inbox = Inbox::default();
        for value in 0..100 {
            inbox.frame(VideoFrame {
                width: 1,
                height: 1,
                rgba: vec![value; 4],
            });
        }
        assert_eq!(inbox.drain().frame.unwrap().rgba, [99; 4]);
        assert!(inbox.drain().frame.is_none());
    }
}
