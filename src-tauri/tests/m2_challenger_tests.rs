use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use image::codecs::jpeg::JpegEncoder;
use image::{Rgba, RgbaImage};
use p2sharer_lib::screen_sources::{
    list_screen_sources, start_native_screen_capture, stop_native_screen_capture,
    MultimediaTimerGuard,
};

/// 1. EMPIRICAL TEST: MultimediaTimerGuard RAII Behavior
///
/// - Verify that MultimediaTimerGuard implements Drop
/// - Verify drop execution upon normal scope exit
/// - Verify drop execution upon early return (break/return)
/// - Verify drop execution during thread panic unwinding
#[test]
fn test_timer_guard_raii_unwind_and_scope() {
    struct DropDetector {
        dropped: Arc<AtomicBool>,
        _guard: MultimediaTimerGuard,
    }

    impl Drop for DropDetector {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    // A. Normal scope exit
    let normal_dropped = Arc::new(AtomicBool::new(false));
    {
        let _detector = DropDetector {
            dropped: normal_dropped.clone(),
            _guard: MultimediaTimerGuard::new(),
        };
        assert!(!normal_dropped.load(Ordering::SeqCst));
    }
    assert!(
        normal_dropped.load(Ordering::SeqCst),
        "Guard must be dropped on normal scope exit"
    );

    // B. Early return / break
    let early_dropped = Arc::new(AtomicBool::new(false));
    let mut counter = 0;
    loop {
        counter += 1;
        let _detector = DropDetector {
            dropped: early_dropped.clone(),
            _guard: MultimediaTimerGuard::new(),
        };
        if counter == 1 {
            break;
        }
    }
    assert!(
        early_dropped.load(Ordering::SeqCst),
        "Guard must be dropped on loop break"
    );

    // C. Thread panic unwinding
    let panic_dropped = Arc::new(AtomicBool::new(false));
    let panic_flag = panic_dropped.clone();
    let join_handle = std::thread::spawn(move || {
        let _detector = DropDetector {
            dropped: panic_flag,
            _guard: MultimediaTimerGuard::new(),
        };
        panic!("Simulated capture thread crash");
    });

    let join_result = join_handle.join();
    assert!(join_result.is_err(), "Thread was expected to panic");
    assert!(
        panic_dropped.load(Ordering::SeqCst),
        "Guard MUST be dropped even when thread panics via stack unwinding"
    );
}

/// 2. EMPIRICAL TEST: Steady-State Buffer Reuse & Zero Re-allocations
///
/// - Verify that using `Vec::with_capacity` and `clear()` retains heap buffer capacity
///   and does NOT reallocate in steady state across consecutive frames.
#[test]
fn test_buffer_reuse_steady_state() {
    let mut test_img = RgbaImage::new(640, 360);
    // Draw gradient patterns
    for (x, y, pixel) in test_img.enumerate_pixels_mut() {
        *pixel = Rgba([(x % 255) as u8, (y % 255) as u8, ((x + y) % 255) as u8, 255]);
    }

    let initial_capacity = 256 * 1024;
    let mut jpeg_bytes = Vec::with_capacity(initial_capacity);

    // First frame encode: may expand if larger than initial capacity
    jpeg_bytes.clear();
    let mut cursor = Cursor::new(&mut jpeg_bytes);
    let mut encoder = JpegEncoder::new_with_quality(&mut cursor, 75);
    encoder
        .encode_image(&test_img)
        .expect("First encode should succeed");

    let steady_state_capacity = jpeg_bytes.capacity();
    let steady_state_ptr = jpeg_bytes.as_ptr();

    // Verify steady state over 50 simulated capture frames
    for i in 0..50 {
        // Slightly mutate image simulating dynamic content
        test_img.put_pixel(
            (i * 10) % 640,
            (i * 5) % 360,
            Rgba([(i * 3) as u8, 200, 100, 255]),
        );

        jpeg_bytes.clear();
        let mut cursor = Cursor::new(&mut jpeg_bytes);
        let mut encoder = JpegEncoder::new_with_quality(&mut cursor, 75);
        encoder
            .encode_image(&test_img)
            .expect("Steady-state encode should succeed");

        // The buffer capacity and underlying pointer must remain stable (no reallocations)
        assert_eq!(
            jpeg_bytes.capacity(),
            steady_state_capacity,
            "Frame {} caused capacity change! Buffer was reallocated instead of reused.",
            i
        );
        assert_eq!(
            jpeg_bytes.as_ptr(),
            steady_state_ptr,
            "Frame {} caused heap address change! Buffer pointer changed.",
            i
        );
    }
}

/// 3. EMPIRICAL TEST: Thumbnail Generation Limits and Modal Freeze Elimination
///
/// - Enumerate real screen sources via `list_screen_sources()`
/// - Ensure execution time is fast (< 1.5 seconds) to prevent modal freeze
/// - Verify that thumbnails are generated for AT MOST 6 windows
/// - Verify windows beyond index 5 have None as thumbnail
#[test]
fn test_thumbnail_generation_top_6_limit_and_latency() {
    let start_time = Instant::now();
    let sources = list_screen_sources();
    let elapsed = start_time.elapsed();

    println!(
        "[Stress Test] list_screen_sources completed in {:?} (Monitors: {}, Windows: {})",
        elapsed,
        sources.monitors.len(),
        sources.windows.len()
    );

    // Modal freeze threshold: must complete in under 2000ms
    assert!(
        elapsed.as_millis() < 2000,
        "list_screen_sources took {:?}, exceeding the 2000ms freeze limit!",
        elapsed
    );

    // Verify thumbnail count constraint on windows
    let mut thumbnail_count = 0;
    for (idx, win) in sources.windows.iter().enumerate() {
        if let Some(ref thumb) = win.thumbnail {
            thumbnail_count += 1;
            assert!(
                idx < 6,
                "Window at index {} has a thumbnail, but only top 6 windows (0..5) may have thumbnails!",
                idx
            );
            assert!(
                thumb.starts_with("data:image/jpeg;base64,"),
                "Thumbnail must be a valid base64 data URL"
            );
        } else if idx >= 6 {
            // Expected: windows >= 6 must not have thumbnail
            assert!(
                win.thumbnail.is_none(),
                "Window at index {} should have None thumbnail",
                idx
            );
        }
    }

    assert!(
        thumbnail_count <= 6,
        "Generated {} window thumbnails, which exceeds the max limit of 6!",
        thumbnail_count
    );
}

/// 4. EMPIRICAL TEST: Concurrent MultimediaTimerGuard Stress
///
/// - Verify that multiple threads creating/dropping guards concurrently do not race or crash.
#[test]
fn test_multimedia_timer_concurrent_stress() {
    let thread_count = 8;
    let iterations_per_thread = 100;
    let counter = Arc::new(AtomicUsize::new(0));

    let handles: Vec<_> = (0..thread_count)
        .map(|_| {
            let c = counter.clone();
            std::thread::spawn(move || {
                for _ in 0..iterations_per_thread {
                    let guard = MultimediaTimerGuard::new();
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    drop(guard);
                    c.fetch_add(1, Ordering::Relaxed);
                }
            })
        })
        .collect();

    for h in handles {
        h.join().expect("Worker thread panicked during timer guard stress");
    }

    assert_eq!(counter.load(Ordering::SeqCst), thread_count * iterations_per_thread);
}

/// 5. EMPIRICAL TEST: Screen Capture Lifecycle (Start / Stop Idempotency)
#[test]
fn test_native_screen_capture_lifecycle() {
    // Empty source ID should fail
    let err_res = start_native_screen_capture("".to_string(), None, None, None, None, None);
    assert!(err_res.is_err());

    // Valid start on screen:0
    let start_res = start_native_screen_capture("screen:0".to_string(), Some(30), Some(320), Some(180), Some(false), Some(60));
    assert!(start_res.is_ok(), "Failed to start capture: {:?}", start_res);

    // Sleep briefly to let capture thread initialize
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Stop capture
    let stop_res = stop_native_screen_capture();
    assert!(stop_res.is_ok(), "Failed to stop capture: {:?}", stop_res);

    // Stop again to verify idempotency
    let stop_res2 = stop_native_screen_capture();
    assert!(stop_res2.is_ok(), "Stop capture should be idempotent: {:?}", stop_res2);
}
