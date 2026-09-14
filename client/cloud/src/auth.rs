use crate::Error;
use serde::{Deserialize, Serialize, Serializer};
use std::fmt;
use zeroize::Zeroizing;

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::AuthTask;
#[cfg(target_arch = "wasm32")]
mod browser;
#[cfg(target_arch = "wasm32")]
pub use browser::AuthTask;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const TIMEOUT_MS: u64 = 20_000;

pub struct Secret(Zeroizing<String>);
impl Secret {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl Clone for Secret {
    fn clone(&self) -> Self {
        Self::new(self.0.to_string())
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}
impl Serialize for Secret {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.expose())
    }
}
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::new)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credentials {
    pub email: String,
    pub password: Secret,
    pub passcode: Option<Secret>,
    pub recovery_code: Option<Secret>,
    /// An already completed normal browser challenge; never solved by the client.
    pub captcha: Option<Secret>,
}

impl Credentials {
    pub fn validate(&self) -> Result<(), Error> {
        if self.email.is_empty()
            || self.email.len() > 320
            || self.password.expose().is_empty()
            || self.password.expose().len() > 4096
            || self
                .passcode
                .as_ref()
                .is_some_and(|s| s.expose().len() > 128)
            || self
                .recovery_code
                .as_ref()
                .is_some_and(|s| s.expose().len() > 128)
            || self
                .captcha
                .as_ref()
                .is_some_and(|s| s.expose().len() > 16 * 1024)
            || self.passcode.is_some() && self.recovery_code.is_some()
        {
            return Err(Error("Invalid sign-in fields"));
        }
        Ok(())
    }
    pub fn request_body(&self) -> Result<Zeroizing<Vec<u8>>, Error> {
        self.validate()?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Request<'a> {
            scope: &'static str,
            email: &'a str,
            password: &'a Secret,
            captcha: &'a str,
            neuron_id: &'static str,
            state: &'static str,
            revoke_previous_device_tokens: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            passcode: Option<&'a Secret>,
            #[serde(skip_serializing_if = "Option::is_none")]
            recoverycode: Option<&'a Secret>,
        }
        serde_json::to_vec(&Request {
            scope: "api-all",
            email: &self.email,
            password: &self.password,
            captcha: self.captcha.as_ref().map_or("", Secret::expose),
            neuron_id: "",
            state: "",
            revoke_previous_device_tokens: false,
            passcode: self.passcode.as_ref(),
            recoverycode: self.recovery_code.as_ref(),
        })
        .map(Zeroizing::new)
        .map_err(|_| Error("Could not encode sign-in request"))
    }
}

pub struct SignedIn {
    pub token: Secret,
    pub email: String,
}
impl fmt::Debug for SignedIn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SignedIn([redacted])")
    }
}

#[derive(Debug)]
pub enum Outcome {
    SignedIn(SignedIn),
    PasscodeRequired,
    PasscodeInvalid,
    CaptchaRequired,
    Rejected,
}

fn parse_response(status: u16, bytes: &[u8]) -> Result<Outcome, Error> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(Error("Sign-in response exceeds the client limit"));
    }
    #[derive(Deserialize)]
    struct ApiError {
        code: String,
    }
    #[derive(Deserialize)]
    struct Response {
        token: Option<String>,
        email: Option<String>,
        #[serde(default)]
        errors: Vec<ApiError>,
    }
    let response: Response =
        serde_json::from_slice(bytes).map_err(|_| Error("Invalid sign-in response"))?;
    let token = response.token.map(Secret::new);
    if response.errors.len() > 16 {
        return Err(Error("Invalid sign-in response"));
    }
    if let Some(error) = response.errors.first() {
        return Ok(match error.code.as_str() {
            "passcode-required" => Outcome::PasscodeRequired,
            "passcode-invalid" => Outcome::PasscodeInvalid,
            "captcha-required" => Outcome::CaptchaRequired,
            _ => Outcome::Rejected,
        });
    }
    if status == 401 || status == 403 {
        return Ok(Outcome::Rejected);
    }
    if !(200..300).contains(&status) {
        return Err(Error("Account service could not complete sign-in"));
    }
    let token = token.ok_or(Error("Account service returned no token"))?;
    validate_token(token.expose())?;
    let email = response
        .email
        .filter(|email| !email.is_empty() && email.len() <= 320)
        .ok_or(Error("Account service returned no account identity"))?;
    Ok(Outcome::SignedIn(SignedIn { token, email }))
}

pub(crate) fn validate_token(token: &str) -> Result<(), Error> {
    if token.is_empty()
        || token.len() > 32 * 1024
        || !token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(Error("Invalid account token"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_uses_normal_scope_without_revoking_other_device_tokens() {
        let credentials = Credentials {
            email: "synthetic@example.test".into(),
            password: Secret::new("synthetic-pass".into()),
            passcode: Some(Secret::new("123456".into())),
            recovery_code: None,
            captcha: None,
        };
        let value: serde_json::Value =
            serde_json::from_slice(&credentials.request_body().unwrap()).unwrap();
        assert_eq!(value["scope"], "api-all");
        assert_eq!(value["revokePreviousDeviceTokens"], false);
        assert_eq!(value["passcode"], "123456");
        assert!(value.get("recoverycode").is_none());
        assert!(!format!("{credentials:?}").contains("synthetic-pass"));
    }
    #[test]
    fn mfa_and_challenge_responses_never_become_signed_in() {
        assert!(matches!(
            parse_response(401, br#"{"errors":[{"code":"passcode-required"}]}"#).unwrap(),
            Outcome::PasscodeRequired
        ));
        assert!(matches!(
            parse_response(401, br#"{"errors":[{"code":"passcode-invalid"}]}"#).unwrap(),
            Outcome::PasscodeInvalid
        ));
        assert!(matches!(
            parse_response(429, br#"{"errors":[{"code":"captcha-required"}]}"#).unwrap(),
            Outcome::CaptchaRequired
        ));
        assert!(parse_response(200, br#"{"token":"synthetic"}"#).is_err());
        let result = parse_response(
            200,
            br#"{"token":"synthetic-secret","email":"test@example.test"}"#,
        )
        .unwrap();
        assert!(matches!(result, Outcome::SignedIn(_)));
        assert!(!format!("{result:?}").contains("synthetic-secret"));
    }
}
