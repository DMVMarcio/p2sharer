use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use p2sharer_lib::screen_sources::{list_screen_sources, MultimediaTimerGuard};

#[test]
#[ignore = "requires an interactive Windows desktop"]
fn thumbnail_generation_is_bounded_and_uses_jpeg_urls() {
    let sources = list_screen_sources();

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
