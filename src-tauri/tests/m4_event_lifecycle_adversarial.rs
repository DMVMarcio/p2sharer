use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_HANDLE, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

/// Re-create the exact EventHandleGuard implementation from audio_loopback.rs
struct EventHandleGuard(HANDLE);

impl Drop for EventHandleGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// 1. RAII Scope Exit: Does CloseHandle execute when EventHandleGuard goes out of scope?
#[test]
fn test_event_handle_guard_scope_cleanup() {
    unsafe {
        let handle = CreateEventW(None, false, false, PCWSTR::null())
            .expect("CreateEventW must succeed");
        assert!(!handle.is_invalid());

        // While open, WaitForSingleObject returns WAIT_TIMEOUT (not WAIT_FAILED)
        let before_wait = WaitForSingleObject(handle, 0);
        assert_eq!(before_wait, WAIT_TIMEOUT, "Open unsignaled event must return WAIT_TIMEOUT");

        {
            let _guard = EventHandleGuard(handle);
            // Guard holds the handle in scope
        } // _guard drops here, executing CloseHandle(handle)

        // After drop, handle is closed. Calling WaitForSingleObject must return WAIT_FAILED
        let after_wait = WaitForSingleObject(handle, 0);
        assert_eq!(
            after_wait, WAIT_FAILED,
            "Calling WaitForSingleObject on closed handle must return WAIT_FAILED"
        );
        let err = GetLastError();
        assert_eq!(
            err, ERROR_INVALID_HANDLE,
            "LastError must be ERROR_INVALID_HANDLE (6)"
        );
    }
}

/// 2. RAII Thread Exit: Does CloseHandle execute when the worker thread terminates?
#[test]
fn test_event_handle_guard_thread_exit_cleanup() {
    unsafe {
        let handle = CreateEventW(None, false, false, PCWSTR::null())
            .expect("CreateEventW must succeed");
        assert!(!handle.is_invalid());

        let raw_val = handle.0 as usize;

        let thread_handle = std::thread::spawn(move || {
            let h = HANDLE(raw_val as *mut _);
            let _guard = EventHandleGuard(h);
            // Simulate brief work
            std::thread::sleep(Duration::from_millis(10));
            // Thread exits -> _guard drops -> CloseHandle executes
        });

        thread_handle.join().expect("Thread must exit cleanly");

        // Verify from parent thread that handle is now invalid
        let wait_res = WaitForSingleObject(handle, 0);
        assert_eq!(
            wait_res, WAIT_FAILED,
            "Handle must be closed and invalid after thread termination"
        );
        assert_eq!(GetLastError(), ERROR_INVALID_HANDLE);
    }
}

/// 3. RAII Panic Unwind: Does CloseHandle execute even if the thread panics?
#[test]
fn test_event_handle_guard_unwind_safety() {
    unsafe {
        let handle = CreateEventW(None, false, false, PCWSTR::null())
            .expect("CreateEventW must succeed");

        let raw_val = handle.0 as usize;

        let thread_handle = std::thread::spawn(move || {
            let h = HANDLE(raw_val as *mut _);
            let _guard = EventHandleGuard(h);
            panic!("Simulated audio thread crash");
        });

        // Thread must panic and return Err
        assert!(thread_handle.join().is_err());

        // Handle must still be properly closed via drop unwinding
        let wait_res = WaitForSingleObject(handle, 0);
        assert_eq!(
            wait_res, WAIT_FAILED,
            "Handle must be closed even after thread panic unwind"
        );
        assert_eq!(GetLastError(), ERROR_INVALID_HANDLE);
    }
}

/// 4. Timeout Polling During Silence: Does WaitForSingleObject poll stop_flag every 20ms and exit promptly?
#[test]
fn test_wait_for_single_object_silence_polling_and_prompt_exit() {
    unsafe {
        let event = CreateEventW(None, false, false, PCWSTR::null())
            .expect("CreateEventW must succeed");
        let _guard = EventHandleGuard(event);

        let stop_flag = Arc::new(AtomicBool::new(true));
        let stop_clone = stop_flag.clone();
        let raw_event = event.0 as usize;

        let thread_handle = std::thread::spawn(move || {
            let h = HANDLE(raw_event as *mut _);
            let mut timeout_ticks = 0usize;

            // This mirrors lines 794-850 of audio_loopback.rs
            while stop_clone.load(Ordering::Relaxed) {
                let wait_res = WaitForSingleObject(h, 20);

                if wait_res == WAIT_OBJECT_0 {
                    // Audio packet arrived (not happening in silence)
                } else if wait_res == WAIT_TIMEOUT {
                    // Timeout: audio engine was silent during this 20ms slice
                    timeout_ticks += 1;
                    continue;
                } else {
                    break;
                }
            }

            timeout_ticks
        });

        // Let the loop run in silence for 100ms. With a 20ms timeout, ~4-6 timeouts should occur.
        std::thread::sleep(Duration::from_millis(100));

        // Signal stop and measure how promptly the thread wakes up and exits
        let stop_start = Instant::now();
        stop_flag.store(false, Ordering::SeqCst);

        let timeout_ticks = thread_handle.join().expect("Worker thread must join");
        let elapsed_to_exit = stop_start.elapsed();

        println!(
            "[Adversarial Test] Worker completed in silence: {} ticks, exit latency: {:?}",
            timeout_ticks, elapsed_to_exit
        );

        // Verification 1: Timeout ticks must be >= 4 (proves it awoke ~every 20ms)
        assert!(
            timeout_ticks >= 4,
            "Expected at least 4 silence timeout ticks during 100ms, got {}",
            timeout_ticks
        );

        // Verification 2: Exit latency MUST be within 20ms timeout + scheduling margin (< 35ms)
        assert!(
            elapsed_to_exit < Duration::from_millis(35),
            "Thread must exit promptly when stopped during silence: took {:?} (exceeded 35ms)",
            elapsed_to_exit
        );
    }
}

/// 5. Event Signal Response: Does WaitForSingleObject wake immediately when audio arrives?
#[test]
fn test_wait_for_single_object_immediate_wake_on_signal() {
    unsafe {
        let event = CreateEventW(None, false, false, PCWSTR::null())
            .expect("CreateEventW must succeed");
        let _guard = EventHandleGuard(event);

        let raw_event = event.0 as usize;
        let wake_signal_time = Arc::new(std::sync::Mutex::new(None));
        let wake_clone = wake_signal_time.clone();

        let thread_handle = std::thread::spawn(move || {
            let h = HANDLE(raw_event as *mut _);
            // Wait with 20ms timeout
            let res = WaitForSingleObject(h, 20);
            let wake_time = Instant::now();
            *wake_clone.lock().unwrap() = Some(wake_time);
            res
        });

        // Brief delay, then signal event
        std::thread::sleep(Duration::from_millis(5));
        let signaled_at = Instant::now();
        let _ = SetEvent(event);

        let wait_res = thread_handle.join().expect("Thread joined");
        assert_eq!(wait_res, WAIT_OBJECT_0, "WaitForSingleObject must return WAIT_OBJECT_0 on signal");

        let woke_at = wake_signal_time.lock().unwrap().unwrap();
        let wake_latency = woke_at.duration_since(signaled_at);

        println!("[Adversarial Test] Wake latency on signal: {:?}", wake_latency);
        assert!(
            wake_latency < Duration::from_millis(15),
            "Event wake latency should be near-instant (< 15ms), was {:?}",
            wake_latency
        );
    }
}
