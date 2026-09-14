use crate::Error;
use std::sync::{Arc, Mutex};

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::Socket;
#[cfg(target_arch = "wasm32")]
mod browser;
#[cfg(target_arch = "wasm32")]
pub use browser::Socket;

const MAX_MESSAGE: usize = 2 * 1024 * 1024 + 5;
const MAX_QUEUED: usize = 4 * 1024 * 1024;
const MAX_EVENTS: usize = 128;

fn retryable_close(code: Option<u16>) -> bool {
    matches!(code, None | Some(1001 | 1005 | 1006 | 1011 | 1012 | 1013))
}

pub enum Event {
    Opened,
    Binary(Vec<u8>),
    Failed(Error),
    Disconnected(Error),
}
#[derive(Default)]
struct Inbox {
    events: Vec<Event>,
    bytes: usize,
    #[cfg(not(target_arch = "wasm32"))]
    outgoing_bytes: usize,
    ended: bool,
}
type Shared = Arc<Mutex<Inbox>>;
impl Inbox {
    fn push(&mut self, event: Event) {
        if self.ended {
            return;
        }
        let size = match &event {
            Event::Binary(bytes) => bytes.len(),
            _ => 0,
        };
        if size > MAX_MESSAGE
            || size > MAX_QUEUED.saturating_sub(self.bytes)
            || self.events.len() >= MAX_EVENTS
        {
            self.fail(Error("Signaling event queue exceeded its limit"));
            return;
        }
        self.bytes += size;
        self.events.push(event);
    }
    fn fail(&mut self, error: Error) {
        if self.ended {
            return;
        }
        self.close();
        self.events.push(Event::Failed(error));
    }
    fn disconnected(&mut self, error: Error) {
        // An account rejection already received must be processed before network loss.
        self.push(Event::Disconnected(error));
        self.ended = true;
    }
    fn close(&mut self) {
        self.ended = true;
        self.events.clear();
        self.bytes = 0;
    }
    fn drain(&mut self) -> Vec<Event> {
        self.bytes = 0;
        std::mem::take(&mut self.events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnect_preserves_earlier_protocol_data_but_overflow_remains_fatal() {
        for code in [1000, 1002, 1003, 1008, 4001] {
            assert!(!retryable_close(Some(code)));
        }
        assert!(retryable_close(Some(1006)));
        assert!(retryable_close(Some(1012)));
        let mut inbox = Inbox::default();
        inbox.push(Event::Binary(vec![1, 2, 3]));
        inbox.disconnected(Error("Synthetic disconnect"));
        inbox.push(Event::Opened);
        assert!(
            matches!(inbox.drain().as_slice(), [Event::Binary(bytes), Event::Disconnected(_)] if bytes == &[1, 2, 3])
        );
        assert!(inbox.drain().is_empty());
        let mut inbox = Inbox::default();
        for _ in 0..MAX_EVENTS {
            inbox.push(Event::Opened);
        }
        inbox.disconnected(Error("Synthetic disconnect"));
        assert!(matches!(inbox.drain().as_slice(), [Event::Failed(_)]));
    }
}
