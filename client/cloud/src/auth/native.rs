use super::*;
use std::{
    io::Read,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

static ACTIVE_REQUESTS: AtomicUsize = AtomicUsize::new(0);
struct RequestSlot;
impl Drop for RequestSlot {
    fn drop(&mut self) {
        ACTIVE_REQUESTS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct AuthTask {
    result: Option<ResultCell>,
    started_ms: u64,
}
type ResultCell = Arc<Mutex<Option<Result<Outcome, Error>>>>;
impl AuthTask {
    pub fn start(credentials: Credentials, now_ms: u64) -> Result<Self, Error> {
        let body = credentials.request_body()?;
        drop(credentials);
        ACTIVE_REQUESTS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 4).then_some(count + 1)
            })
            .map_err(|_| Error("Previous sign-in requests are still finishing"))?;
        let slot = RequestSlot;
        let result = Arc::new(Mutex::new(None));
        let weak = Arc::downgrade(&result);
        std::thread::Builder::new()
            .name("crabfleet-account-signin".into())
            .spawn(move || {
                let _slot = slot;
                let outcome = request(&body);
                if let Some(result) = weak.upgrade() {
                    *result.lock().unwrap() = Some(outcome);
                }
            })
            .map_err(|_| Error("Could not start account request"))?;
        Ok(Self {
            result: Some(result),
            started_ms: now_ms,
        })
    }
    pub fn poll(&mut self, now_ms: u64) -> Option<Result<Outcome, Error>> {
        let result = self.result.as_ref()?;
        let outcome = result.lock().unwrap().take();
        if outcome.is_some() {
            self.result = None;
            return outcome;
        }
        if now_ms.saturating_sub(self.started_ms) > TIMEOUT_MS {
            self.result = None;
            return Some(Err(Error("Account sign-in timed out")));
        }
        None
    }
    pub fn cancel(&mut self) {
        self.result = None;
    }
}

fn request(body: &[u8]) -> Result<Outcome, Error> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(TIMEOUT_MS))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| Error("Could not initialize account HTTPS client"))?;
    request_to(&client, crate::AUTH_URL, body)
}

fn request_to(
    client: &reqwest::blocking::Client,
    url: &str,
    body: &[u8],
) -> Result<Outcome, Error> {
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(body.to_vec())
        .send()
        .map_err(|_| Error("Could not reach the account service"))?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(Error("Sign-in response exceeds the client limit"));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Error("Could not read account response"))?;
    parse_response(status, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn password_and_mfa_requests_roundtrip_over_real_loopback_http() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/user/auth", listener.local_addr().unwrap());
        let host = std::thread::spawn(move || {
            for stage in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                    assert!(headers.len() <= 16 * 1024);
                }
                let headers = String::from_utf8(headers).unwrap();
                assert!(headers.starts_with("POST /v1/user/auth HTTP/1.1\r\n"));
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap();
                assert!(length <= 32 * 1024);
                let mut bytes = vec![0; length];
                stream.read_exact(&mut bytes).unwrap();
                let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(request["email"], "synthetic@example.test");
                assert_eq!(request["password"], "synthetic-password");
                assert_eq!(request["revokePreviousDeviceTokens"], false);
                let (status, body) = if stage == 0 {
                    assert!(request.get("passcode").is_none());
                    (
                        "401 Unauthorized",
                        r#"{"errors":[{"code":"passcode-required"}]}"#,
                    )
                } else {
                    assert_eq!(request["passcode"], "123456");
                    (
                        "200 OK",
                        r#"{"token":"synthetic-token","email":"synthetic@example.test"}"#,
                    )
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let mut credentials = Credentials {
            email: "synthetic@example.test".into(),
            password: Secret::new("synthetic-password".into()),
            passcode: None,
            recovery_code: None,
            captcha: None,
        };
        assert!(matches!(
            request_to(&client, &url, &credentials.request_body().unwrap()).unwrap(),
            Outcome::PasscodeRequired
        ));
        credentials.passcode = Some(Secret::new("123456".into()));
        let result = request_to(&client, &url, &credentials.request_body().unwrap()).unwrap();
        assert!(matches!(result, Outcome::SignedIn(_)));
        host.join().unwrap();
    }
}
