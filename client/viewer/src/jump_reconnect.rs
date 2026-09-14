//! Bounded recovery of a user's selected session; every replacement authenticates anew.
use crabfleet_cloud::account::State;

const DELAYS_MS: [u64; 5] = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECOVERY_LIMIT_MS: u64 = 120_000;
const STABLE_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Delay,
    Account,
    Computer,
    Host,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub stage: Stage,
    pub attempt: u8,
    pub remaining_seconds: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Account,
    Host(String),
    Exhausted,
}
#[derive(Clone, Copy)]
enum Phase {
    Delay(u64),
    Account,
    Host,
}
#[derive(Default)]
pub struct Recovery {
    enabled: bool,
    target: Option<String>,
    host_confirmed: bool,
    phase: Option<Phase>,
    attempts: u8,
    started_ms: Option<u64>,
    stable_since_ms: Option<u64>,
}
impl Recovery {
    pub fn enable(&mut self) {
        *self = Self {
            enabled: true,
            ..Self::default()
        };
    }
    pub fn select(&mut self, id: String) {
        self.enable();
        self.target = Some(id);
    }
    pub fn target(&self) -> Option<&str> {
        self.target.as_deref()
    }
    pub fn active(&self) -> bool {
        self.phase.is_some()
    }
    pub fn cancel(&mut self) {
        *self = Self::default();
    }
    pub fn cancel_host(&mut self) {
        self.target = None;
        self.host_confirmed = false;
        self.phase = None;
        self.attempts = 0;
        self.started_ms = None;
        self.stable_since_ms = None;
    }
    pub fn confirm_host(&mut self) {
        self.host_confirmed = self.target.is_some();
    }
    pub fn host_lost(&mut self, now_ms: u64) -> bool {
        if !self.host_confirmed {
            self.cancel_host();
            return false;
        }
        self.schedule(now_ms)
    }
    fn schedule(&mut self, now_ms: u64) -> bool {
        if !self.enabled {
            return false;
        }
        if !self.host_confirmed {
            self.target = None;
        }
        self.started_ms.get_or_insert(now_ms);
        self.stable_since_ms = None;
        let delay = DELAYS_MS
            .get(usize::from(self.attempts))
            .copied()
            .unwrap_or(0);
        self.phase = Some(Phase::Delay(now_ms.saturating_add(delay)));
        true
    }
    pub fn poll(
        &mut self,
        now_ms: u64,
        account: State,
        retryable: bool,
        target_online: bool,
        viewing: bool,
    ) -> Option<Step> {
        if !self.enabled {
            return None;
        }
        if matches!(account, State::Failed(_)) {
            if !retryable {
                self.cancel();
                return None;
            }
            if !matches!(self.phase, Some(Phase::Delay(_))) {
                self.schedule(now_ms);
            }
        }
        if self.phase.is_some()
            && (self.attempts >= DELAYS_MS.len() as u8
                && matches!(self.phase, Some(Phase::Delay(_)))
                || self
                    .started_ms
                    .is_some_and(|start| now_ms.saturating_sub(start) >= RECOVERY_LIMIT_MS))
        {
            self.cancel();
            return Some(Step::Exhausted);
        }
        if let Some(Phase::Delay(due)) = self.phase {
            if now_ms < due {
                return None;
            }
            self.attempts += 1;
            self.phase = Some(Phase::Account);
            if matches!(account, State::Failed(_)) {
                return Some(Step::Account);
            }
        }
        if matches!(self.phase, Some(Phase::Account)) && account == State::Ready {
            if let Some(id) = &self.target {
                if target_online {
                    self.phase = Some(Phase::Host);
                    return Some(Step::Host(id.clone()));
                }
            } else {
                self.phase = None;
            }
        }
        if matches!(self.phase, Some(Phase::Host)) && viewing {
            self.phase = None;
        }
        if self.phase.is_none() && account == State::Ready && (self.target.is_none() || viewing) {
            let since = self.stable_since_ms.get_or_insert(now_ms);
            if now_ms.saturating_sub(*since) >= STABLE_MS {
                self.attempts = 0;
                self.started_ms = None;
            }
        } else {
            self.stable_since_ms = None;
        }
        None
    }
    pub fn status(&self, now_ms: u64, account: State) -> Option<Status> {
        Some(match self.phase? {
            Phase::Delay(due) => Status {
                stage: Stage::Delay,
                attempt: self.attempts + 1,
                remaining_seconds: due.saturating_sub(now_ms).div_ceil(1000),
            },
            Phase::Account => Status {
                stage: if account == State::Ready {
                    Stage::Computer
                } else {
                    Stage::Account
                },
                attempt: self.attempts,
                remaining_seconds: 0,
            },
            Phase::Host => Status {
                stage: Stage::Host,
                attempt: self.attempts,
                remaining_seconds: 0,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FAILED: State = State::Failed(crabfleet_cloud::Error("Synthetic network loss"));

    #[test]
    fn network_recovery_waits_for_fresh_presence_and_a_new_host_grant() {
        let mut recovery = Recovery::default();
        recovery.select("selected computer".into());
        recovery.confirm_host();
        assert_eq!(recovery.poll(0, FAILED, true, false, false), None);
        assert_eq!(recovery.poll(999, FAILED, true, false, false), None);
        assert_eq!(
            recovery.poll(1000, FAILED, true, false, false),
            Some(Step::Account)
        );
        assert_eq!(
            recovery.poll(1001, State::Connecting, false, false, false),
            None
        );
        assert_eq!(recovery.poll(2000, State::Ready, false, false, false), None);
        assert_eq!(
            recovery.status(2000, State::Ready).unwrap().stage,
            Stage::Computer
        );
        assert_eq!(
            recovery.poll(2001, State::Ready, false, true, false),
            Some(Step::Host("selected computer".into()))
        );
        assert_eq!(recovery.poll(2002, State::Ready, false, true, false), None);
        assert!(recovery.active());
        recovery.poll(2003, State::Ready, false, true, true);
        assert!(!recovery.active());
    }
    #[test]
    fn rejection_cancel_and_unapproved_hosts_do_not_reconnect() {
        let mut recovery = Recovery::default();
        recovery.select("not yet approved".into());
        assert!(!recovery.host_lost(0));
        recovery.poll(1, FAILED, true, false, false);
        recovery.poll(1001, FAILED, true, false, false);
        assert_eq!(recovery.poll(1002, State::Ready, false, true, false), None);
        assert!(recovery.target().is_none());
        recovery.poll(2000, FAILED, false, false, false);
        assert!(!recovery.active());
        assert_eq!(recovery.poll(9999, FAILED, true, true, false), None);
        recovery.enable();
        recovery.poll(0, FAILED, true, false, false);
        recovery.cancel();
        assert_eq!(recovery.poll(9999, FAILED, true, true, false), None);
    }
    #[test]
    fn flapping_connections_exhaust_five_attempts_and_stable_connections_reset_budget() {
        let mut recovery = Recovery::default();
        recovery.enable();
        let mut now = 0;
        for delay in DELAYS_MS {
            assert_eq!(recovery.poll(now, FAILED, true, false, false), None);
            now += delay;
            assert_eq!(
                recovery.poll(now, FAILED, true, false, false),
                Some(Step::Account)
            );
            recovery.poll(now + 1, State::Ready, false, false, false);
            now += 2;
        }
        assert_eq!(
            recovery.poll(now, FAILED, true, false, false),
            Some(Step::Exhausted)
        );
        assert_eq!(
            recovery.poll(now + 100_000, FAILED, true, false, false),
            None
        );
        recovery.enable();
        recovery.poll(0, FAILED, true, false, false);
        recovery.poll(1000, FAILED, true, false, false);
        recovery.poll(2000, State::Ready, false, false, false);
        recovery.poll(32_000, State::Ready, false, false, false);
        recovery.poll(32_001, FAILED, true, false, false);
        assert_eq!(recovery.status(32_001, FAILED).unwrap().attempt, 1);
    }
    #[test]
    fn offline_host_wait_has_a_deadline_and_revocation_cancels_host_recovery() {
        let mut recovery = Recovery::default();
        recovery.select("selected computer".into());
        recovery.confirm_host();
        assert!(recovery.host_lost(0));
        assert_eq!(recovery.poll(1000, State::Ready, false, false, false), None);
        assert_eq!(
            recovery.poll(120_000, State::Ready, false, false, false),
            Some(Step::Exhausted)
        );
        recovery.select("selected computer".into());
        recovery.confirm_host();
        recovery.host_lost(0);
        recovery.cancel_host();
        assert_eq!(recovery.poll(1000, State::Ready, false, true, true), None);
        assert!(!recovery.active());
        assert!(recovery.target().is_none());
    }
}
