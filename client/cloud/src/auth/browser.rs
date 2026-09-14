use super::*;
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    AbortController, ReadableStreamDefaultReader, ReferrerPolicy, Request, RequestCache,
    RequestCredentials, RequestInit, RequestMode, RequestRedirect, Response,
};

type ResultCell = Rc<RefCell<Option<Result<Outcome, Error>>>>;
pub struct AuthTask {
    result: Option<ResultCell>,
    abort: AbortController,
    started_ms: u64,
}
impl AuthTask {
    pub fn start(credentials: Credentials, now_ms: u64) -> Result<Self, Error> {
        credentials.validate()?;
        let body = Zeroizing::new(
            serde_json::to_vec(&credentials)
                .map_err(|_| Error("Could not encode account request"))?,
        );
        drop(credentials);
        let abort =
            AbortController::new().map_err(|_| Error("Browser cancellation is unavailable"))?;
        let init = RequestInit::new();
        init.set_method("POST");
        init.set_mode(RequestMode::SameOrigin);
        // Inheriting no-referrer makes Firefox send Origin: null on this POST.
        init.set_referrer_policy(ReferrerPolicy::SameOrigin);
        init.set_credentials(RequestCredentials::Omit);
        init.set_redirect(RequestRedirect::Error);
        init.set_cache(RequestCache::NoStore);
        init.set_signal(Some(&abort.signal()));
        let body_text = std::str::from_utf8(&body).map_err(|_| Error("Invalid sign-in request"))?;
        init.set_body(&JsValue::from_str(body_text));
        let request = Request::new_with_str_and_init(
            &crate::gateway_url(crate::GATEWAY_AUTH_PATH, false)?,
            &init,
        )
        .map_err(|_| Error("Could not create account request"))?;
        request
            .headers()
            .set("Content-Type", "application/json")
            .map_err(|_| Error("Could not set account request headers"))?;
        request
            .headers()
            .set("Accept", "application/json")
            .map_err(|_| Error("Could not set account request headers"))?;
        let promise = web_sys::window()
            .ok_or(Error("Browser window is unavailable"))?
            .fetch_with_request(&request);
        let result = Rc::new(RefCell::new(None));
        let weak = Rc::downgrade(&result);
        let cancel = abort.clone();
        spawn_local(async move {
            let outcome = read_response(promise).await;
            if outcome.is_err() {
                cancel.abort();
            }
            if let Some(result) = weak.upgrade() {
                *result.borrow_mut() = Some(outcome);
            }
        });
        Ok(Self {
            result: Some(result),
            abort,
            started_ms: now_ms,
        })
    }
    pub fn poll(&mut self, now_ms: u64) -> Option<Result<Outcome, Error>> {
        let outcome = self.result.as_ref()?.borrow_mut().take();
        if outcome.is_some() {
            self.result = None;
            return outcome;
        }
        if now_ms.saturating_sub(self.started_ms) > TIMEOUT_MS {
            self.cancel();
            return Some(Err(Error("Account sign-in timed out")));
        }
        None
    }
    pub fn cancel(&mut self) {
        self.result = None;
        self.abort.abort();
    }
}
impl Drop for AuthTask {
    fn drop(&mut self) {
        self.cancel();
    }
}

async fn read_response(promise: js_sys::Promise) -> Result<Outcome, Error> {
    let response: Response = JsFuture::from(promise)
        .await
        .map_err(|_| Error("Could not reach the web gateway"))?
        .dyn_into()
        .map_err(|_| Error("Invalid browser account response"))?;
    if response.status() == 429 {
        return Err(Error("The web gateway is busy; try again shortly"));
    }
    if response.status() >= 500 {
        return Err(Error("The web gateway could not reach the account service"));
    }
    if matches!(response.status(), 404 | 405) {
        return Err(Error("Open the viewer through crabfleet-web-gateway"));
    }
    if response
        .headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(Error("Sign-in response exceeds the client limit"));
    }
    let reader: ReadableStreamDefaultReader = response
        .body()
        .ok_or(Error("Account response has no body"))?
        .get_reader()
        .dyn_into()
        .map_err(|_| Error("Could not read account response stream"))?;
    let mut bytes = Zeroizing::new(Vec::new());
    loop {
        let next = JsFuture::from(reader.read())
            .await
            .map_err(|_| Error("Could not read account response"))?;
        let done = js_sys::Reflect::get(&next, &JsValue::from_str("done"))
            .map_err(|_| Error("Invalid response stream"))?
            .as_bool()
            .unwrap_or(false);
        if done {
            break;
        }
        let value = js_sys::Reflect::get(&next, &JsValue::from_str("value"))
            .map_err(|_| Error("Invalid response stream"))?;
        let chunk: js_sys::Uint8Array = value
            .dyn_into()
            .map_err(|_| Error("Invalid response stream chunk"))?;
        if chunk.length() as usize > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(Error("Sign-in response exceeds the client limit"));
        }
        bytes.extend_from_slice(&chunk.to_vec());
    }
    reader.release_lock();
    parse_response(response.status(), &bytes)
}
