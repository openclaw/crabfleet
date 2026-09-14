use super::jump_runtime::{Command, Runtime, Snapshot};
use crabfleet_rtc::VideoFrame;

#[derive(Default)]
pub struct Update {
    pub snapshot: Snapshot,
    pub frame: Option<VideoFrame>,
}
impl Update {
    fn publish(&mut self, snapshot: &Snapshot, frame: Option<VideoFrame>) -> bool {
        let changed = self.snapshot != *snapshot || frame.is_some();
        if self.snapshot.epoch != snapshot.epoch
            || self.snapshot.media_revision != snapshot.media_revision
            || !snapshot.permissions.can_view()
        {
            self.frame = None;
        }
        self.snapshot = snapshot.clone();
        if frame.is_some() && snapshot.permissions.can_view() {
            self.frame = frame;
        }
        changed
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod platform {
    use super::*;
    use crate::jump_runtime::MAX_COMMAND_BYTES;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant};

    pub struct Bridge {
        sender: mpsc::SyncSender<Command>,
        output: Arc<Mutex<Update>>,
        alive: Arc<AtomicBool>,
        bytes: Arc<AtomicUsize>,
    }
    struct WorkerLifetime(Arc<AtomicBool>);
    impl Drop for WorkerLifetime {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    impl Bridge {
        pub fn new(ctx: eframe::egui::Context) -> Self {
            let (sender, receiver) = mpsc::sync_channel::<Command>(128);
            let output = Arc::new(Mutex::new(Update::default()));
            let alive = Arc::new(AtomicBool::new(true));
            let bytes = Arc::new(AtomicUsize::new(0));
            let (worker_output, worker_alive, worker_bytes) =
                (output.clone(), alive.clone(), bytes.clone());
            let spawn = std::thread::Builder::new()
                .name("jump-session".into())
                .spawn(move || {
                    let _lifetime = WorkerLifetime(worker_alive.clone());
                    // Every GStreamer operation, including teardown, stays on this worker.
                    let mut runtime = Runtime::default();
                    let started = Instant::now();
                    while worker_alive.load(Ordering::Acquire) {
                        let now = started.elapsed().as_millis() as u64;
                        for _ in 0..128 {
                            let Ok(command) = receiver.try_recv() else {
                                break;
                            };
                            worker_bytes.fetch_sub(command.action.bytes(), Ordering::AcqRel);
                            if !worker_alive.load(Ordering::Acquire) {
                                break;
                            }
                            runtime.command(command, now);
                        }
                        if !worker_alive.load(Ordering::Acquire) {
                            break;
                        }
                        let frame = runtime.poll(now);
                        let changed = worker_output
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .publish(&runtime.snapshot, frame);
                        if changed {
                            ctx.request_repaint();
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                });
            if spawn.is_err() {
                alive.store(false, Ordering::Release);
                output
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .snapshot
                    .error = Some("Could not start the session worker".into());
            }
            Self {
                sender,
                output,
                alive,
                bytes,
            }
        }
        pub fn send(&mut self, command: Command, _: u64) -> Result<(), &'static str> {
            if !self.alive.load(Ordering::Acquire) {
                return Err("The session worker stopped; reopen the viewer");
            }
            let count = command.action.bytes();
            let reserved = self
                .bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                    used.checked_add(count)
                        .filter(|sum| *sum <= MAX_COMMAND_BYTES)
                })
                .is_ok();
            if !reserved || self.sender.try_send(command).is_err() {
                if reserved {
                    self.bytes.fetch_sub(count, Ordering::AcqRel);
                }
                // Dropping input releases can leave keys held. Stop the entire session.
                self.alive.store(false, Ordering::Release);
                return Err("Session command queue overflowed; reopen the viewer");
            }
            Ok(())
        }
        pub fn poll(&mut self, _: u64) -> Update {
            let mut output = self.output.lock().unwrap_or_else(|e| e.into_inner());
            if !self.alive.load(Ordering::Acquire) {
                output.frame = None;
                output.snapshot.permissions = Default::default();
                output.snapshot.cursor = Default::default();
                output.snapshot.computer = None;
                output
                    .snapshot
                    .error
                    .get_or_insert_with(|| "The session worker stopped; reopen the viewer".into());
            }
            Update {
                snapshot: output.snapshot.clone(),
                frame: output.frame.take(),
            }
        }
    }
    impl Drop for Bridge {
        fn drop(&mut self) {
            self.alive.store(false, Ordering::Release);
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod platform {
    use super::*;
    use crate::jump_runtime::MAX_COMMAND_BYTES;
    pub struct Bridge {
        runtime: Runtime,
    }
    impl Bridge {
        pub fn new(_: eframe::egui::Context) -> Self {
            Self {
                runtime: Runtime::default(),
            }
        }
        pub fn send(&mut self, command: Command, now: u64) -> Result<(), &'static str> {
            if command.action.bytes() > MAX_COMMAND_BYTES {
                return Err("Session command exceeds the size limit");
            }
            // Execute audio activation during the user's gesture, before yielding.
            self.runtime.command(command, now);
            Ok(())
        }
        pub fn poll(&mut self, now: u64) -> Update {
            let frame = self.runtime.poll(now);
            let mut update = Update::default();
            update.publish(&self.runtime.snapshot, frame);
            update
        }
    }
}
pub use platform::Bridge;

#[cfg(test)]
mod tests {
    use super::*;
    use crabfleet_fluid::{control::*, session::Session};
    fn permissions() -> crabfleet_fluid::session::Permissions {
        let mut session = Session::default();
        session.open(0, true, false);
        session
            .receive(
                session.generation(),
                Control {
                    peer_info: Some(PeerInfo {
                        supports_interactive_auth: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                1,
            )
            .unwrap();
        session
            .receive(
                session.generation(),
                Control {
                    auth: Some(HostAuth {
                        access_mask_updated: Some(7),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                2,
            )
            .unwrap();
        session.permissions()
    }
    fn frame(value: u8) -> VideoFrame {
        VideoFrame {
            width: 1,
            height: 1,
            rgba: vec![value; 4],
        }
    }
    #[test]
    fn pending_frame_is_latest_only_and_cannot_cross_revocation_or_host_switch() {
        let mut inbox = Update::default();
        let mut snapshot = Snapshot {
            epoch: 1,
            permissions: permissions(),
            ..Default::default()
        };
        inbox.publish(&snapshot, Some(frame(1)));
        inbox.publish(&snapshot, Some(frame(2)));
        assert_eq!(inbox.frame.as_ref().unwrap().rgba, [2; 4]);
        // Even a revoke/regrant within one poll must invalidate the cached frame.
        snapshot.media_revision += 1;
        inbox.publish(&snapshot, None);
        assert!(inbox.frame.is_none());
        inbox.publish(&snapshot, Some(frame(3)));
        snapshot.epoch += 1;
        inbox.publish(&snapshot, None);
        assert!(inbox.frame.is_none());
        snapshot.permissions = Default::default();
        inbox.publish(&snapshot, Some(frame(4)));
        assert!(inbox.frame.is_none());
    }
}
