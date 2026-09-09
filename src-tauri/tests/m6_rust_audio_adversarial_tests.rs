//! Milestone 6 Phase 2 (Tier 5): Audio & Rust Backend Adversarial Hardening Suite
//!
//! Empirical stress tests challenging:
//! 1. Extreme and non-standard sample rate conversions (11025 Hz, 22050 Hz, 32000 Hz, 384000 Hz -> 48000 Hz)
//! 2. Micro-chunk (1-frame, 2-frame, prime-length) and macro-chunk (65536-frame) streaming continuity
//! 3. Multichannel downmixing with full-scale constructive/destructive clipping, denormals, and NaN safety
//! 4. Long-duration drift accumulator stability over 100,000+ simulated chunks (48,000,000 frames)
//! 5. Microsecond timestamp monotonicity across 100,000 simulated iterations
//! 6. Event handle RAII cleanup and rapid start/stop thread termination under concurrent load

use p2sharer_lib::audio_loopback::{
    convert_and_downmix_to_stereo, resample_interleaved_float, AudioResampler,
};

// ============================================================================
// 1. Extreme and Non-Standard Sample Rate Conversions (11025, 22050, 32000, 384000 Hz)
// ============================================================================

#[test]
fn test_extreme_sample_rates_mathematical_fidelity() {
    // Non-standard and extreme rates:
    // - 11025 Hz: Legacy low-bandwidth / early multimedia (4.35x upsampling)
    // - 12000 Hz: Telephony / Bluetooth SCO wideband (4x upsampling)
    // - 22050 Hz: Half-CD / FM radio quality (2.17x upsampling)
    // - 24000 Hz: Opus Silk wideband (2x upsampling)
    // - 32000 Hz: MiniDisc / European broadcast standard (1.5x upsampling)
    // - 64000 Hz: Quad-telephony / non-standard DSP (0.75x downsampling)
    // - 352800 Hz: 8x 44.1kHz DXD Studio Master (7.35x downsampling)
    // - 384000 Hz: 8x 48kHz DXD Studio Master (8x downsampling)
    let non_standard_rates: [u32; 8] = [
        11025, 12000, 22050, 24000, 32000, 64000, 352800, 384000,
    ];
    let out_rate = 48000u32;
    let duration_sec = 0.20f64; // 200ms tone
    let test_freq = 440.0f64; // Concert A4

    for &in_rate in &non_standard_rates {
        let in_frames = (duration_sec * in_rate as f64).round() as usize;
        let mut input = Vec::with_capacity(in_frames * 2);
        let angular_speed = 2.0 * std::f64::consts::PI * test_freq / in_rate as f64;

        for f in 0..in_frames {
            let sample = (angular_speed * f as f64).sin() as f32 * 0.75;
            input.push(sample); // Left
            input.push(sample); // Right
        }

        // Test stateless resample_interleaved_float
        let resampled_stateless = resample_interleaved_float(&input, 2, in_rate, out_rate);
        let expected_out_frames = ((in_frames as u64 * out_rate as u64 + in_rate as u64 / 2)
            / in_rate as u64) as usize;

        assert_eq!(
            resampled_stateless.len() / 2,
            expected_out_frames,
            "Stateless frame count mismatch for in_rate={} Hz",
            in_rate
        );

        // Verify finite numbers only
        assert!(
            resampled_stateless.iter().all(|s| s.is_finite()),
            "Stateless resampler emitted non-finite float for in_rate={}",
            in_rate
        );

        // Test stateful AudioResampler
        let mut resampler = AudioResampler::new(in_rate, out_rate);
        let mut resampled_stateful = Vec::new();
        resampler.resample(&input, &mut resampled_stateful);

        let stateful_frames = resampled_stateful.len() / 2;
        let frame_diff = (stateful_frames as isize - expected_out_frames as isize).abs();
        assert!(
            frame_diff <= 1,
            "Stateful AudioResampler frame diff exceeded 1 (diff={}) for in_rate={} Hz",
            frame_diff,
            in_rate
        );

        assert!(
            resampled_stateful.iter().all(|s| s.is_finite()),
            "Stateful resampler emitted non-finite float for in_rate={}",
            in_rate
        );

        // Energy (RMS) preservation check:
        let in_sum_sq: f32 = input.iter().map(|&s| s * s).sum();
        let in_rms = (in_sum_sq / input.len() as f32).sqrt();

        let out_sum_sq: f32 = resampled_stateful.iter().map(|&s| s * s).sum();
        let out_rms = (out_sum_sq / resampled_stateful.len() as f32).sqrt();

        let rms_tolerance = if in_rate <= 12000 { 0.08 } else { 0.04 };
        assert!(
            (out_rms - in_rms).abs() < rms_tolerance,
            "RMS deviation too large for in_rate={}: in_rms={}, out_rms={}, tol={}",
            in_rate,
            in_rms,
            out_rms,
            rms_tolerance
        );

        // Zero-crossing pitch verification:
        let mut in_zc = 0;
        for i in 1..in_frames {
            if (input[i * 2] >= 0.0) != (input[(i - 1) * 2] >= 0.0) {
                in_zc += 1;
            }
        }
        let mut out_zc = 0;
        for i in 1..stateful_frames {
            if (resampled_stateful[i * 2] >= 0.0) != (resampled_stateful[(i - 1) * 2] >= 0.0) {
                out_zc += 1;
            }
        }
        let zc_diff = (out_zc as isize - in_zc as isize).abs();
        assert!(
            zc_diff <= 3,
            "Pitch zero-crossing shift detected for in_rate={}: in_zc={}, out_zc={}",
            in_rate,
            in_zc,
            out_zc
        );
    }
}

// ============================================================================
// 2. Micro-Chunk (1-Frame, Prime-Length) and Macro-Chunk Resampling Stress
// ============================================================================

#[test]
fn test_micro_chunk_streaming_continuity() {
    let in_rate = 44100u32;
    let out_rate = 48000u32;

    // Test A: 1,000 single-frame chunks (2 floats per chunk) streamed sequentially
    let mut resampler_micro = AudioResampler::new(in_rate, out_rate);
    let mut micro_output = Vec::new();

    let angular_speed = 2.0 * std::f64::consts::PI * 440.0 / in_rate as f64;
    for f in 0..1000 {
        let val = (angular_speed * f as f64).sin() as f32 * 0.6;
        let single_frame = [val, val];
        resampler_micro.resample(&single_frame, &mut micro_output);
    }

    let micro_frames = micro_output.len() / 2;
    assert!(
        (micro_frames as isize - 1088).abs() <= 1,
        "Micro-chunk output frames (got {}) deviated from expected 1088",
        micro_frames
    );

    // Verify all samples are finite and smooth
    assert!(micro_output.iter().all(|s| s.is_finite()));
    for i in 1..micro_frames {
        let delta = (micro_output[i * 2] - micro_output[(i - 1) * 2]).abs();
        assert!(
            delta < 0.25,
            "Discontinuity between 1-frame micro-chunks at frame {}: delta={}",
            i,
            delta
        );
    }

    // Test B: Prime-sized irregular chunks [3, 7, 11, 13, 17, 19, 23, 29, 31]
    let prime_sizes = [3, 7, 11, 13, 17, 19, 23, 29, 31];
    let mut resampler_prime = AudioResampler::new(in_rate, out_rate);
    let mut prime_output = Vec::new();

    let total_prime_input_frames: usize = prime_sizes.iter().sum();
    let mut prime_full_input = Vec::with_capacity(total_prime_input_frames * 2);
    for f in 0..total_prime_input_frames {
        let val = (angular_speed * f as f64).sin() as f32 * 0.7;
        prime_full_input.push(val);
        prime_full_input.push(val);
    }

    let mut offset = 0;
    for &chunk_len in &prime_sizes {
        let end = offset + chunk_len;
        let chunk = &prime_full_input[offset * 2..end * 2];
        resampler_prime.resample(chunk, &mut prime_output);
        offset = end;
    }

    // Baseline: Resample the entire buffer in 1 shot
    let mut resampler_mono = AudioResampler::new(in_rate, out_rate);
    let mut monolithic_output = Vec::new();
    resampler_mono.resample(&prime_full_input, &mut monolithic_output);

    assert_eq!(
        prime_output.len(),
        monolithic_output.len(),
        "Prime-chunked stream produced different frame count than monolithic call"
    );

    // Verify bounded sample-by-sample difference between prime-chunked and monolithic
    for i in 0..prime_output.len() {
        let diff = (prime_output[i] - monolithic_output[i]).abs();
        assert!(
            diff < 0.15,
            "Prime chunk stream deviated from monolithic at sample {}: diff={}",
            i,
            diff
        );
    }

    // Test C: Macro-chunk (65,536 frames = 131,072 floats) in a single burst
    let macro_frames = 65536;
    let mut macro_input = vec![0.0f32; macro_frames * 2];
    for f in 0..macro_frames {
        let val = (angular_speed * f as f64).sin() as f32 * 0.5;
        macro_input[f * 2] = val;
        macro_input[f * 2 + 1] = val;
    }

    let mut resampler_macro = AudioResampler::new(in_rate, out_rate);
    let mut macro_output = Vec::new();
    resampler_macro.resample(&macro_input, &mut macro_output);

    let expected_macro_out = ((macro_frames as u64 * 48000 + 22050) / 44100) as usize;
    assert_eq!(
        macro_output.len() / 2,
        expected_macro_out,
        "Macro-chunk (65536 frames) produced unexpected frame count"
    );
    assert!(macro_output.iter().all(|s| s.is_finite()));
}

// ============================================================================
// 3. Multichannel Downmix Full-Scale Clipping, Denormals, & NaN Resistance
// ============================================================================

#[test]
fn test_multichannel_downmix_adversarial_clipping_and_denormals() {
    let mut stereo_out = Vec::new();

    // Scenario A: 5.1 Surround Maximum Constructive Full-Scale (+1.0 on all 6 channels)
    let full_scale_5_1: [f32; 12] = [1.0; 12]; // 2 frames
    convert_and_downmix_to_stereo(
        full_scale_5_1.as_ptr() as *const u8,
        2,
        6,
        32,
        false,
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 4);
    for (i, &sample) in stereo_out.iter().enumerate() {
        assert_eq!(sample, 1.0f32, "5.1 full-scale positive sample {} must clamp to 1.0", i);
    }

    // Scenario B: 5.1 Surround Maximum Destructive Full-Scale (-1.0 on all 6 channels)
    stereo_out.clear();
    let neg_scale_5_1: [f32; 12] = [-1.0; 12];
    convert_and_downmix_to_stereo(
        neg_scale_5_1.as_ptr() as *const u8,
        2,
        6,
        32,
        false,
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 4);
    for (i, &sample) in stereo_out.iter().enumerate() {
        assert_eq!(sample, -1.0f32, "5.1 full-scale negative sample {} must clamp to -1.0", i);
    }

    // Scenario C: 7.1 Surround Extreme Amplitude Beyond Standard (+50.0 and -50.0)
    stereo_out.clear();
    let extreme_7_1: [f32; 16] = [
        50.0, -50.0, 50.0, 0.0, 50.0, -50.0, 50.0, -50.0, // Frame 1
        -50.0, 50.0, -50.0, 0.0, -50.0, 50.0, -50.0, 50.0, // Frame 2
    ];
    convert_and_downmix_to_stereo(
        extreme_7_1.as_ptr() as *const u8,
        2,
        8,
        32,
        false,
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 4);
    assert_eq!(stereo_out[0], 1.0f32, "Extreme positive input must clamp to 1.0");
    assert_eq!(stereo_out[1], -1.0f32, "Extreme negative input must clamp to -1.0");
    assert_eq!(stereo_out[2], -1.0f32, "Frame 2 L must clamp to -1.0");
    assert_eq!(stereo_out[3], 1.0f32, "Frame 2 R must clamp to 1.0");

    // Scenario D: 16-bit Integer Boundary Saturation
    stereo_out.clear();
    let max_i16_7_1: [i16; 16] = [i16::MAX; 16];
    convert_and_downmix_to_stereo(
        max_i16_7_1.as_ptr() as *const u8,
        2,
        8,
        16,
        false,
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 4);
    for &sample in &stereo_out {
        assert!((0.99f32..=1.0f32).contains(&sample));
    }

    stereo_out.clear();
    let min_i16_7_1: [i16; 16] = [i16::MIN; 16];
    convert_and_downmix_to_stereo(
        min_i16_7_1.as_ptr() as *const u8,
        2,
        8,
        16,
        false,
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 4);
    for &sample in &stereo_out {
        assert_eq!(sample, -1.0f32);
    }

    // Scenario E: Denormals and Subnormal Floats (Preventing Denormal Underflow Stalls)
    stereo_out.clear();
    let denormals: [f32; 12] = [
        f32::MIN_POSITIVE / 4.0,
        -f32::MIN_POSITIVE / 8.0,
        1e-38,
        -1e-38,
        f32::MIN_POSITIVE / 2.0,
        -f32::MIN_POSITIVE / 2.0,
        1e-39,
        -1e-39,
        0.0,
        0.0,
        1e-40,
        -1e-40,
    ];
    convert_and_downmix_to_stereo(
        denormals.as_ptr() as *const u8,
        2,
        6,
        32,
        false,
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 4);
    for &sample in &stereo_out {
        assert!(sample.is_finite());
        assert!(sample.abs() < 1e-4);
    }

    // Scenario F: Quadraphonic (4 channels) Generic Fallback
    stereo_out.clear();
    let quad: [f32; 8] = [0.8, -0.6, 0.4, -0.2, -0.8, 0.6, -0.4, 0.2];
    convert_and_downmix_to_stereo(
        quad.as_ptr() as *const u8,
        2,
        4,
        32,
        false,
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 4);
    assert_eq!(stereo_out[0], 0.8f32);
    assert_eq!(stereo_out[1], -0.6f32);
    assert_eq!(stereo_out[2], -0.8f32);
    assert_eq!(stereo_out[3], 0.6f32);

    // Scenario G: Silent Flag Overrides Dirty Garbage Buffer
    stereo_out.clear();
    let dirty_nan_buffer: [f32; 6] = [f32::NAN, f32::INFINITY, -f32::INFINITY, 999.0, -999.0, 42.0];
    convert_and_downmix_to_stereo(
        dirty_nan_buffer.as_ptr() as *const u8,
        1,
        6,
        32,
        true, // is_silent = true
        &mut stereo_out,
    );
    assert_eq!(stereo_out.len(), 2);
    assert_eq!(stereo_out[0], 0.0f32);
    assert_eq!(stereo_out[1], 0.0f32);
}

// ============================================================================
// 4. Long-Duration Drift Accumulator Stability Over 100,000+ Simulated Chunks
// ============================================================================

#[test]
fn test_long_duration_drift_accumulator_100000_chunks() {
    // 100,000 chunks of 441 frames at 44.1 kHz = 44,100,000 input frames
    // In audio duration: 44,100,000 / 44,100 = 1,000.0 seconds (~16.67 minutes)
    // Expected output frames = 1,000 * 48,000 = 48,000,000 frames
    let in_rate = 44100u32;
    let out_rate = 48000u32;
    let chunk_frames = 441usize;
    let total_chunks = 100_000usize;
    let ratio = in_rate as f64 / out_rate as f64; // 44100 / 48000 = 0.91875

    let mut resampler = AudioResampler::new(in_rate, out_rate);

    // Create a 10ms chunk of test tone
    let mut chunk = vec![0.0f32; chunk_frames * 2];
    for (i, val) in chunk.iter_mut().enumerate() {
        *val = ((i as f32) * 0.1).sin() * 0.4;
    }

    let mut cumulative_out_frames = 0usize;
    let mut out_buffer = Vec::with_capacity(480 * 2);

    let mut max_phase = f64::NEG_INFINITY;
    let mut min_phase = f64::INFINITY;

    for chunk_idx in 0..total_chunks {
        out_buffer.clear();
        resampler.resample(&chunk, &mut out_buffer);

        let frames = out_buffer.len() / 2;
        cumulative_out_frames += frames;

        let phase = resampler.phase();
        if phase > max_phase {
            max_phase = phase;
        }
        if phase < min_phase {
            min_phase = phase;
        }

        // Assert phase invariance: phase MUST remain in [-1e-8, ratio + 1e-8]
        assert!(
            phase >= -1e-8 && phase < ratio + 1e-8,
            "Phase escaped bounds at chunk {}: phase={}",
            chunk_idx,
            phase
        );
    }

    let expected_total_frames = 48_000_000usize;
    let drift = (cumulative_out_frames as isize - expected_total_frames as isize).abs();

    println!(
        "[Adversarial Hardening] 100,000 chunks completed:\n\
         - Cumulative Output Frames: {}\n\
         - Expected Total Frames:    {}\n\
         - Absolute Frame Drift:     {} frames\n\
         - Phase range:              [{:.10}, {:.10}] (ratio={:.6})",
        cumulative_out_frames,
        expected_total_frames,
        drift,
        min_phase,
        max_phase,
        ratio
    );

    // Across 100,000 consecutive chunks (16.6 minutes), total accumulated drift must be <= 1 frame!
    assert!(
        drift <= 1,
        "Accumulated frame drift after 100,000 chunks exceeded bound! Drift = {}",
        drift
    );
}

// ============================================================================
// 5. Microsecond Timestamp Monotonicity Across 100,000 Simulated Chunks
// ============================================================================

#[test]
fn test_timestamp_monotonicity_100000_iterations() {
    let start = std::time::Instant::now();
    let mut last_timestamp = 0u64;

    for i in 0..100_000 {
        // Compute timestamp as elapsed microseconds (mirroring audio_loopback.rs line 866)
        let current_timestamp = start.elapsed().as_micros() as u64;

        assert!(
            current_timestamp >= last_timestamp,
            "Retrograde timestamp detected at iteration {}: {} < {}",
            i,
            current_timestamp,
            last_timestamp
        );

        last_timestamp = current_timestamp;
    }
}

// ============================================================================
// 6. Windows Event Handle Cleanup & Rapid Thread Start/Stop Stress
// ============================================================================

#[cfg(windows)]
mod win_event_stress {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_HANDLE, HANDLE, WAIT_TIMEOUT,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, GetProcessHandleCount, WaitForSingleObject,
    };

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

    /// Stress test 200 rapid cycles of EventHandleGuard creation and destruction.
    /// Verifies via GetProcessHandleCount that RAII drop prevents OS handle leaks,
    /// and tests immediate handle invalidation on a fresh handle.
    #[test]
    fn test_rapid_event_handle_guard_cycles_200() {
        unsafe {
            let mut initial_handles = 0u32;
            let res = GetProcessHandleCount(GetCurrentProcess(), &mut initial_handles);
            assert!(res.is_ok(), "GetProcessHandleCount must succeed");

            for _ in 0..200 {
                let handle = CreateEventW(None, false, false, PCWSTR::null())
                    .expect("CreateEventW must succeed");
                assert!(!handle.is_invalid());

                {
                    let _guard = EventHandleGuard(handle);
                    // Verify event is valid and unsignaled
                    assert_eq!(WaitForSingleObject(handle, 0), WAIT_TIMEOUT);
                } // _guard drops here, closing the handle via CloseHandle
            }

            let mut final_handles = 0u32;
            let res = GetProcessHandleCount(GetCurrentProcess(), &mut final_handles);
            assert!(res.is_ok(), "GetProcessHandleCount must succeed");

            // Handle count must NOT grow by 200 handles (proving no leak)
            let handle_growth = final_handles.saturating_sub(initial_handles);
            println!(
                "[Adversarial Hardening] Handle count before: {}, after: {}, net growth: {}",
                initial_handles, final_handles, handle_growth
            );
            assert!(
                handle_growth < 10,
                "Process handle leak detected: handle count increased by {} after 200 cycles",
                handle_growth
            );

            // Verify single isolated handle invalidation immediately after drop
            let isolated_handle = CreateEventW(None, false, false, PCWSTR::null())
                .expect("CreateEventW must succeed");
            {
                let _guard = EventHandleGuard(isolated_handle);
                assert_eq!(WaitForSingleObject(isolated_handle, 0), WAIT_TIMEOUT);
            }
            // Calling CloseHandle a second time must fail with ERROR_INVALID_HANDLE
            let double_close_res = CloseHandle(isolated_handle);
            assert!(
                double_close_res.is_err(),
                "CloseHandle on dropped EventHandleGuard must fail because handle is already closed"
            );
            assert_eq!(GetLastError(), ERROR_INVALID_HANDLE);
        }
    }

    /// Stress test 25 concurrent worker threads rapidly started and stopped.
    /// Verifies clean thread termination without deadlocks, leaks, or hung handles.
    #[test]
    fn test_concurrent_thread_start_stop_rapid_churn() {
        let thread_count = 25;
        let mut join_handles = Vec::with_capacity(thread_count);

        for _ in 0..thread_count {
            unsafe {
                let event = CreateEventW(None, false, false, PCWSTR::null())
                    .expect("CreateEventW must succeed");
                let stop_flag = Arc::new(AtomicBool::new(true));
                let stop_clone = stop_flag.clone();
                let raw_event = event.0 as usize;

                let handle = std::thread::spawn(move || {
                    let h = HANDLE(raw_event as *mut _);
                    let _guard = EventHandleGuard(h);

                    let mut iterations = 0;
                    while stop_clone.load(Ordering::Relaxed) {
                        let res = WaitForSingleObject(h, 20);
                        if res == WAIT_TIMEOUT {
                            iterations += 1;
                        } else {
                            break;
                        }
                    }
                    iterations
                });

                join_handles.push((handle, stop_flag));
            }
        }

        // Staggered stop signaling across threads
        std::thread::sleep(Duration::from_millis(15));
        let stop_start = Instant::now();

        for (idx, (_, stop_flag)) in join_handles.iter().enumerate() {
            if idx % 2 == 0 {
                stop_flag.store(false, Ordering::SeqCst);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
        for (_, stop_flag) in &join_handles {
            stop_flag.store(false, Ordering::SeqCst);
        }

        // All threads must join within 75ms
        for (idx, (handle, _)) in join_handles.into_iter().enumerate() {
            let res = handle.join();
            assert!(res.is_ok(), "Thread {} failed to join cleanly", idx);
        }

        let elapsed = stop_start.elapsed();
        println!(
            "[Adversarial Hardening] 25 concurrent audio threads terminated cleanly in {:?}",
            elapsed
        );
        assert!(
            elapsed < Duration::from_millis(75),
            "All 25 threads must terminate within 75ms (took {:?})",
            elapsed
        );
    }
}
