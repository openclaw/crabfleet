use super::*;
use wasm_bindgen::{JsCast, closure::Closure};
use web_sys::{BinaryType, WebSocket};

pub struct Socket {
    socket: WebSocket,
    inbox: Shared,
    handlers: Vec<Closure<dyn FnMut(web_sys::Event)>>,
}
impl Socket {
    pub fn connect() -> Result<Self, Error> {
        let socket = WebSocket::new_with_str(
            &crate::gateway_url(crate::GATEWAY_SIGNAL_PATH, true)?,
            crate::GATEWAY_PROTOCOL,
        )
        .map_err(|_| Error("Could not create signaling connection"))?;
        socket.set_binary_type(BinaryType::Arraybuffer);
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        let mut handlers = Vec::new();
        let weak = Arc::downgrade(&inbox);
        let open = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {
            if let Some(inbox) = weak.upgrade() {
                inbox.lock().unwrap().push(Event::Opened);
            }
        });
        socket.set_onopen(Some(open.as_ref().unchecked_ref()));
        handlers.push(open);
        let weak = Arc::downgrade(&inbox);
        let message = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            if let Some(inbox) = weak.upgrade() {
                if let Ok(event) = event.dyn_into::<web_sys::MessageEvent>()
                    && let Ok(buffer) = event.data().dyn_into::<js_sys::ArrayBuffer>()
                    && buffer.byte_length() as usize <= MAX_MESSAGE
                {
                    inbox
                        .lock()
                        .unwrap()
                        .push(Event::Binary(js_sys::Uint8Array::new(&buffer).to_vec()));
                    return;
                }
                inbox
                    .lock()
                    .unwrap()
                    .fail(Error("Invalid signaling WebSocket message"));
            }
        });
        socket.set_onmessage(Some(message.as_ref().unchecked_ref()));
        handlers.push(message);
        // The following close event supplies the code; an error event must not
        // erase a policy/auth rejection before it can be classified.
        let error = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {});
        socket.set_onerror(Some(error.as_ref().unchecked_ref()));
        handlers.push(error);
        let weak = Arc::downgrade(&inbox);
        let close = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            if let Some(inbox) = weak.upgrade() {
                let mut inbox = inbox.lock().unwrap();
                let retryable = event
                    .dyn_into::<web_sys::CloseEvent>()
                    .ok()
                    .is_some_and(|event| retryable_close(Some(event.code())));
                let error = Error("Signaling server disconnected");
                if retryable {
                    inbox.disconnected(error);
                } else {
                    inbox.fail(error);
                }
            }
        });
        socket.set_onclose(Some(close.as_ref().unchecked_ref()));
        handlers.push(close);
        Ok(Self {
            socket,
            inbox,
            handlers,
        })
    }
    /// Queue a message; `poll` reports failures without replacing a pending close reason.
    pub fn send(&mut self, bytes: Vec<u8>) {
        let mut inbox = self.inbox.lock().unwrap();
        if inbox.ended {
            return;
        }
        if bytes.len() > MAX_MESSAGE {
            inbox.fail(Error("Signaling message exceeds its limit"));
            return;
        }
        if self.socket.ready_state() != WebSocket::OPEN {
            // The close event owns the policy-versus-network classification.
            return;
        }
        if self.socket.buffered_amount() as usize + bytes.len() > MAX_QUEUED {
            inbox.fail(Error("Signaling write queue exceeded its limit"));
            return;
        }
        if self.socket.send_with_u8_array(&bytes).is_err()
            && self.socket.ready_state() == WebSocket::OPEN
        {
            inbox.fail(Error("Signaling write failed"));
        }
    }
    pub fn poll(&mut self) -> Vec<Event> {
        let (events, ended) = {
            let mut inbox = self.inbox.lock().unwrap();
            (inbox.drain(), inbox.ended)
        };
        if ended {
            self.close();
        }
        events
    }
    pub fn close(&mut self) {
        self.inbox.lock().unwrap().close();
        self.socket.set_onopen(None);
        self.socket.set_onmessage(None);
        self.socket.set_onerror(None);
        self.socket.set_onclose(None);
        let _ = self.socket.close();
        self.handlers.clear();
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        self.close();
    }
}
