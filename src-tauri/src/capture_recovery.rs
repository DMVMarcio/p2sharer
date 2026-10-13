//! Capture recovery policy: desktop switches are pauses, not source closures.

#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    Continue,
    Wait,
    Restart,
    SourceGone,
    Failed,
    Stop,
}

#[derive(Default)]
pub struct CaptureRecovery {
    pending: bool,
    retry_at_ms: u64,
    failures: u8,
}

impl CaptureRecovery {
    pub fn observe(
        &mut self,
        active: bool,
        desktop_available: bool,
        source_exists: bool,
        backend_finished: bool,
        now_ms: u64,
    ) -> RecoveryAction {
        if !active {
            return RecoveryAction::Stop;
        }
        if !desktop_available {
            self.pending = true;
            self.failures = 0;
            self.retry_at_ms = now_ms;
            return RecoveryAction::Wait;
        }
        if !source_exists {
            return RecoveryAction::SourceGone;
        }
        if self.failures >= 5 {
            return RecoveryAction::Failed;
        }
        if self.pending || backend_finished {
            if now_ms < self.retry_at_ms {
                RecoveryAction::Wait
            } else {
                RecoveryAction::Restart
            }
        } else {
            RecoveryAction::Continue
        }
    }

    pub fn restarted(&mut self, success: bool, now_ms: u64) {
        self.pending = !success;
        if success {
            self.failures = 0;
        } else {
            self.failures += 1;
            self.retry_at_ms = now_ms + 500;
        }
    }
}

#[cfg(windows)]
pub fn input_desktop_available() -> bool {
    use windows::Win32::{
        Foundation::HANDLE,
        System::{
            StationsAndDesktops::{
                CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop,
                DESKTOP_READOBJECTS, UOI_NAME,
            },
            Threading::GetCurrentThreadId,
        },
    };
    unsafe {
        let Ok(input) = OpenInputDesktop(Default::default(), false, DESKTOP_READOBJECTS) else {
            return false;
        };
        let result = (|| {
            let thread = GetThreadDesktop(GetCurrentThreadId()).ok()?;
            let mut current_name = [0u16; 256];
            let mut input_name = [0u16; 256];
            GetUserObjectInformationW(
                HANDLE(thread.0),
                UOI_NAME,
                Some(current_name.as_mut_ptr().cast()),
                std::mem::size_of_val(&current_name) as u32,
                None,
            )
            .ok()?;
            GetUserObjectInformationW(
                HANDLE(input.0),
                UOI_NAME,
                Some(input_name.as_mut_ptr().cast()),
                std::mem::size_of_val(&input_name) as u32,
                None,
            )
            .ok()?;
            Some(current_name == input_name)
        })();
        let _ = CloseDesktop(input);
        result.unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secure_desktop_preserves_session_and_restarts_on_return() {
        let mut recovery = CaptureRecovery::default();
        for now in [0, 500, 30_000, 300_000] {
            // Source queries can also fail while the secure desktop is active.
            assert_eq!(
                recovery.observe(true, false, false, true, now),
                RecoveryAction::Wait
            );
        }
        assert_eq!(
            recovery.observe(true, true, true, true, 300_250),
            RecoveryAction::Restart
        );
        recovery.restarted(true, 300_250);
        assert_eq!(
            recovery.observe(true, true, true, false, 300_500),
            RecoveryAction::Continue
        );
    }
    #[test]
    fn cancellation_and_actual_source_loss_are_terminal() {
        let mut recovery = CaptureRecovery::default();
        recovery.observe(true, false, false, true, 0);
        assert_eq!(
            recovery.observe(false, true, true, true, 500),
            RecoveryAction::Stop
        );
        assert_eq!(
            recovery.observe(true, true, false, true, 500),
            RecoveryAction::SourceGone
        );
    }
    #[test]
    fn unexpected_backend_exit_retries_with_backoff_without_looping_forever() {
        let mut recovery = CaptureRecovery::default();
        for attempt in 0..5 {
            let now = attempt * 500;
            assert_eq!(
                recovery.observe(true, true, true, true, now),
                RecoveryAction::Restart
            );
            recovery.restarted(false, now);
            if attempt < 4 {
                assert_eq!(
                    recovery.observe(true, true, true, true, now + 250),
                    RecoveryAction::Wait
                );
            }
        }
        assert_eq!(
            recovery.observe(true, true, true, true, 2_500),
            RecoveryAction::Failed
        );
    }
}
