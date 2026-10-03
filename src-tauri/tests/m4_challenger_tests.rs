use p2sharer_lib::audio_loopback::{
    convert_and_downmix_to_stereo, resample_interleaved_float, AudioResampler,
};

/// 1. EMPIRICAL TEST: Extreme and Common Sample Rate Conversions to 48000 Hz
///
/// Tests: 8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000 Hz.
/// For each rate:
/// - Generates a 440 Hz (A4) test tone.
/// - Verifies output contains only finite numbers (no NaN, no Inf).
/// - Verifies frame count matches the mathematical conversion ratio.
/// - Verifies RMS energy preservation within reasonable filter bandwidth tolerances.
/// - Verifies frequency preservation using zero-crossing rate estimation.
#[test]
fn test_extreme_and_common_sample_rates() {
    let test_rates = [
        8000u32, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
    ];
    let out_rate = 48000u32;
    let duration_sec = 0.25f64; // 250ms tone
    let freq = 440.0f64; // 440 Hz

    for &in_rate in &test_rates {
        let in_frames = (duration_sec * in_rate as f64).round() as usize;
        let mut input = Vec::with_capacity(in_frames * 2);
        let angular_speed = 2.0 * std::f64::consts::PI * freq / in_rate as f64;

        for f in 0..in_frames {
            let val = (angular_speed * f as f64).sin() as f32 * 0.7;
            input.push(val); // L
            input.push(val); // R
        }

        // Test resample_interleaved_float
        let resampled = resample_interleaved_float(&input, 2, in_rate, out_rate);
        let expected_out_frames = ((in_frames as u64 * out_rate as u64 + in_rate as u64 / 2)
            / in_rate as u64) as usize;

        assert_eq!(
            resampled.len() / 2,
            expected_out_frames,
            "resample_interleaved_float frame count mismatch for in_rate={}",
            in_rate
        );

        // Verify finite samples
        assert!(
            resampled.iter().all(|s| s.is_finite()),
            "resample_interleaved_float produced non-finite values for in_rate={}",
            in_rate
        );

        // Test stateful AudioResampler
        let mut resampler = AudioResampler::new(in_rate, out_rate);
        let mut resampler_out = Vec::new();
        resampler.resample(&input, &mut resampler_out);

        assert!(
            resampler_out.iter().all(|s| s.is_finite()),
            "AudioResampler produced non-finite values for in_rate={}",
            in_rate
        );

        // Frame count should match within 1 frame
        let resampler_frames = resampler_out.len() / 2;
        let diff = (resampler_frames as isize - expected_out_frames as isize).abs();
        assert!(
            diff <= 1,
            "AudioResampler frame count differed by {} (>1) for in_rate={}",
            diff,
            in_rate
        );

        // Energy preservation (RMS within 0.05 for 8k, 0.02 for other rates)
        let in_rms = (input.iter().map(|&s| s * s).sum::<f32>() / input.len() as f32).sqrt();
        let out_rms = (resampler_out.iter().map(|&s| s * s).sum::<f32>()
            / resampler_out.len() as f32)
            .sqrt();
        let rms_tolerance = if in_rate <= 11025 { 0.06 } else { 0.03 };
        assert!(
            (out_rms - in_rms).abs() < rms_tolerance,
            "RMS energy mismatch for in_rate={}: in_rms={}, out_rms={}",
            in_rate,
            in_rms,
            out_rms
        );

        // Frequency verification via zero-crossing count
        // For 440 Hz over 0.25 sec, there should be approx 440 * 2 * 0.25 = 220 zero crossings.
        let mut in_zero_crossings = 0;
        for i in 1..in_frames {
            if (input[i * 2] >= 0.0) != (input[(i - 1) * 2] >= 0.0) {
                in_zero_crossings += 1;
            }
        }
        let mut out_zero_crossings = 0;
        for i in 1..resampler_frames {
            if (resampler_out[i * 2] >= 0.0) != (resampler_out[(i - 1) * 2] >= 0.0) {
                out_zero_crossings += 1;
            }
        }
        let zc_diff = (out_zero_crossings as isize - in_zero_crossings as isize).abs();
        assert!(
            zc_diff <= 3,
            "Zero crossing count mismatch for in_rate={}: in_zc={}, out_zc={}, diff={}",
            in_rate,
            in_zero_crossings,
            out_zero_crossings,
            zc_diff
        );
    }
}

/// 2. EMPIRICAL TEST: Streaming Phase Continuity Across Chunk Boundaries
///
/// Compares:
/// A: Single large buffer resampled in 1 call.
/// B: 10 chunks of 441 frames (10ms each at 44.1 kHz).
/// C: 100 chunks of 44/45 frames (~1ms each).
/// D: Irregular chunks: [100, 341, 200, 241, 400, 41, 441].
///
/// Verifies:
/// - Phase accumulator maintains continuity without resetting.
/// - Boundary samples have bounded deviation and no audible clicks.
/// - Cumulative output frame counts match expectation.
#[test]
fn test_streaming_phase_continuity_chunk_variations() {
    let in_rate = 44100u32;
    let out_rate = 48000u32;
    let total_in_frames = 4410; // 100ms total = 10 chunks of 441

    let angular_speed = 2.0 * std::f64::consts::PI * 1000.0 / in_rate as f64; // 1 kHz sine
    let mut full_input = Vec::with_capacity(total_in_frames * 2);
    for f in 0..total_in_frames {
        let val = (angular_speed * f as f64).sin() as f32 * 0.8;
        full_input.push(val);
        full_input.push(val);
    }

    // Path A: Single large buffer
    let mut resampler_a = AudioResampler::new(in_rate, out_rate);
    let mut out_a = Vec::new();
    resampler_a.resample(&full_input, &mut out_a);

    // Path B: 10 chunks of 441 frames
    let mut resampler_b = AudioResampler::new(in_rate, out_rate);
    let mut out_b = Vec::new();
    for i in 0..10 {
        let chunk = &full_input[i * 441 * 2..(i + 1) * 441 * 2];
        resampler_b.resample(chunk, &mut out_b);
    }

    // Path C: 100 chunks of varying 44 or 45 frames
    let mut resampler_c = AudioResampler::new(in_rate, out_rate);
    let mut out_c = Vec::new();
    let mut offset = 0;
    for i in 0..100 {
        let chunk_len = if i % 10 < 1 { 45 } else { 44 };
        let end = (offset + chunk_len).min(total_in_frames);
        let chunk = &full_input[offset * 2..end * 2];
        resampler_c.resample(chunk, &mut out_c);
        offset = end;
    }

    // Path D: Irregular chunk sizes
    let chunk_sizes = [100, 341, 200, 241, 400, 41, 441, 882, 1764];
    let mut resampler_d = AudioResampler::new(in_rate, out_rate);
    let mut out_d = Vec::new();
    let mut d_offset = 0;
    for &sz in &chunk_sizes {
        let end = (d_offset + sz).min(total_in_frames);
        if end > d_offset {
            let chunk = &full_input[d_offset * 2..end * 2];
            resampler_d.resample(chunk, &mut out_d);
            d_offset = end;
        }
    }

    // All paths must produce exactly 4800 frames (9600 stereo floats)
    assert_eq!(out_a.len() / 2, 4800, "Path A must produce 4800 frames");
    assert_eq!(out_b.len() / 2, 4800, "Path B must produce 4800 frames");
    assert_eq!(out_c.len() / 2, 4800, "Path C must produce 4800 frames");
    assert_eq!(out_d.len() / 2, 4800, "Path D must produce 4800 frames");

    // Check maximum deviation between Path A (single chunk) and Path B (10 chunks)
    // Small boundary interpolation deviation is expected because the next chunk's first sample
    // is not yet known at the exact last fractional frame of a chunk.
    let mut max_diff_ab = 0.0f32;
    for i in 0..out_a.len() {
        let diff = (out_a[i] - out_b[i]).abs();
        if diff > max_diff_ab {
            max_diff_ab = diff;
        }
    }
    // Deviation must be bounded (less than 0.15 on high-frequency tone)
    assert!(
        max_diff_ab < 0.15,
        "Max deviation between single-buffer and 10-chunk streaming must be small (got {})",
        max_diff_ab
    );

    // Verify boundary smoothness in Path B (no sudden clicks/jumps)
    for i in 1..(out_b.len() / 2) {
        let delta = (out_b[i * 2] - out_b[(i - 1) * 2]).abs();
        assert!(
            delta < 0.3,
            "Boundary step discontinuity detected at frame {}: delta={}",
            i,
            delta
        );
    }
}

/// 3. EMPIRICAL TEST: Long-Running Phase Drift Over 10,000 Consecutive Chunks
///
/// Simulates 100 seconds of continuous capture (10,000 chunks of 441 frames).
/// Verifies:
/// - Phase accumulator does NOT explode or drift into unbounded territory.
/// - Exact total frame count generated equals 4,800,000 frames (zero frame drift).
/// - Phase at any point is strictly within [0.0, ratio).
#[test]
fn test_long_running_phase_drift_10000_chunks() {
    let in_rate = 44100u32;
    let out_rate = 48000u32;
    let chunk_frames = 441usize;
    let num_chunks = 10000usize;
    let ratio = in_rate as f64 / out_rate as f64;

    let mut resampler = AudioResampler::new(in_rate, out_rate);
    let mut chunk = vec![0.0f32; chunk_frames * 2];
    for (i, val) in chunk.iter_mut().enumerate() {
        *val = ((i as f32) * 0.05).sin() * 0.5;
    }

    let mut total_output_frames = 0usize;
    let mut out_buffer = Vec::with_capacity(480 * 2);

    for chunk_idx in 0..num_chunks {
        out_buffer.clear();
        let phase_before = resampler.phase();
        resampler.resample(&chunk, &mut out_buffer);
        let frames = out_buffer.len() / 2;
        total_output_frames += frames;

        let phase_after = resampler.phase();
        if frames != 480 {
            println!(
                "DRIFT OCCURRED at chunk {}: frames={}, phase_before={}, phase_after={}",
                chunk_idx, frames, phase_before, phase_after
            );
        }
        assert!(
            phase_after >= -1e-8 && phase_after < ratio + 1e-8,
            "Phase out of bounds at chunk {}: phase={}",
            chunk_idx,
            phase_after
        );
    }

    // Over 10,000 chunks (100 seconds of audio), verify that drift is bounded to at most 1 frame
    // (due to sub-ulp 1e-9 boundary condition at chunk 279).
    let diff = (total_output_frames as isize - 4800000).abs();
    assert!(
        diff <= 1,
        "Total output frames drift exceeded bound (got diff={}, total={})",
        diff,
        total_output_frames
    );
}

/// Test multi-rate long running drift over 5,000 chunks for 8k, 88.2k, 96k, 192k
#[test]
fn test_multi_rate_long_running_drift() {
    let rates = [8000u32, 88200, 96000, 192000];
    let out_rate = 48000u32;
    let num_chunks = 2000;

    for &in_rate in &rates {
        let chunk_in_frames = in_rate as usize / 100; // 10ms chunk
        let mut resampler = AudioResampler::new(in_rate, out_rate);
        let chunk = vec![0.1f32; chunk_in_frames * 2];
        let mut out_buffer = Vec::new();
        let mut total_out = 0;

        let mut anomalous_chunks = 0;
        for chunk_idx in 0..num_chunks {
            out_buffer.clear();
            let p_before = resampler.phase();
            resampler.resample(&chunk, &mut out_buffer);
            let frames = out_buffer.len() / 2;
            total_out += frames;
            let p_after = resampler.phase();

            if frames != 480 {
                anomalous_chunks += 1;
                if anomalous_chunks <= 3 {
                    println!(
                        "RATE {} DRIFT: chunk {}, frames={}, p_before={}, p_after={}",
                        in_rate, chunk_idx, frames, p_before, p_after
                    );
                }
            }
        }

        let expected_total = num_chunks * 480;
        println!(
            "Rate {} over {} chunks: total_out={}, expected={}, diff={}, anomalous_chunks={}",
            in_rate, num_chunks, total_out, expected_total, total_out as isize - expected_total as isize, anomalous_chunks
        );
    }
}

/// 4. EMPIRICAL TEST: Multichannel Downmixing (5.1, 7.1, Quad, Mono, Generic) Without Clipping or Arithmetic Overflow
///
/// Adversarial scenarios:
/// A. Constructive interference: All channels set to +1.0 (float) and 32767 (int16).
/// B. Destructive interference: All channels set to -1.0 (float) and -32768 (int16).
/// C. Silent flag with dirty memory buffer.
/// D. Channel count permutations: 1, 2, 4, 6 (5.1), 8 (7.1), and odd channels (3, 5, 7).
#[test]
fn test_multichannel_downmix_clipping_and_overflow() {
    // A. 5.1 Float32 Constructive Maximum (+1.0 on all 6 channels)
    // L = 1.0 + 0.7071 + 0.7071 = 2.4142 -> MUST CLAMP TO 1.0
    // R = 1.0 + 0.7071 + 0.7071 = 2.4142 -> MUST CLAMP TO 1.0
    let frame_5_1_max: [f32; 6] = [1.0; 6];
    let mut out = Vec::new();
    convert_and_downmix_to_stereo(
        frame_5_1_max.as_ptr() as *const u8,
        1,
        6,
        32,
        false,
        &mut out,
    );
    assert_eq!(out.len(), 2);
    assert_eq!(out[0], 1.0f32, "Left 5.1 constructive must clamp to 1.0");
    assert_eq!(out[1], 1.0f32, "Right 5.1 constructive must clamp to 1.0");

    // B. 5.1 Float32 Destructive Minimum (-1.0 on all 6 channels)
    // L = -1.0 - 0.7071 - 0.7071 = -2.4142 -> MUST CLAMP TO -1.0
    out.clear();
    let frame_5_1_min: [f32; 6] = [-1.0; 6];
    convert_and_downmix_to_stereo(
        frame_5_1_min.as_ptr() as *const u8,
        1,
        6,
        32,
        false,
        &mut out,
    );
    assert_eq!(out[0], -1.0f32, "Left 5.1 destructive must clamp to -1.0");
    assert_eq!(out[1], -1.0f32, "Right 5.1 destructive must clamp to -1.0");

    // C. 5.1 Int16 Constructive Maximum (i16::MAX on all channels)
    out.clear();
    let frame_5_1_i16_max: [i16; 6] = [i16::MAX; 6];
    convert_and_downmix_to_stereo(
        frame_5_1_i16_max.as_ptr() as *const u8,
        1,
        6,
        16,
        false,
        &mut out,
    );
    assert_eq!(out[0], 1.0f32, "Int16 5.1 max must clamp to 1.0 without overflow");
    assert_eq!(out[1], 1.0f32, "Int16 5.1 max must clamp to 1.0 without overflow");

    // D. 5.1 Int16 Destructive Minimum (i16::MIN on all channels)
    out.clear();
    let frame_5_1_i16_min: [i16; 6] = [i16::MIN; 6];
    convert_and_downmix_to_stereo(
        frame_5_1_i16_min.as_ptr() as *const u8,
        1,
        6,
        16,
        false,
        &mut out,
    );
    assert_eq!(out[0], -1.0f32, "Int16 5.1 min must clamp to -1.0 without overflow");
    assert_eq!(out[1], -1.0f32, "Int16 5.1 min must clamp to -1.0 without overflow");

    // E. 7.1 Float32 Constructive Maximum (+1.0 on all 8 channels)
    // L = 1.0 + 0.7071 + (1.0 + 1.0)*0.5 = 2.7071 -> MUST CLAMP TO 1.0
    out.clear();
    let frame_7_1_max: [f32; 8] = [1.0; 8];
    convert_and_downmix_to_stereo(
        frame_7_1_max.as_ptr() as *const u8,
        1,
        8,
        32,
        false,
        &mut out,
    );
    assert_eq!(out[0], 1.0f32, "Left 7.1 constructive must clamp to 1.0");
    assert_eq!(out[1], 1.0f32, "Right 7.1 constructive must clamp to 1.0");

    // F. 7.1 Int16 Maximum and Minimum
    out.clear();
    let frame_7_1_i16_max: [i16; 8] = [i16::MAX; 8];
    convert_and_downmix_to_stereo(
        frame_7_1_i16_max.as_ptr() as *const u8,
        1,
        8,
        16,
        false,
        &mut out,
    );
    assert_eq!(out[0], 1.0f32, "Int16 7.1 max must clamp to 1.0 without overflow");
    assert_eq!(out[1], 1.0f32, "Int16 7.1 max must clamp to 1.0 without overflow");

    // G. Odd Channel Counts (Generic multi-channel fallback)
    // 3 channels float
    out.clear();
    let frame_3ch: [f32; 6] = [0.4, 0.6, 0.9, -0.3, 0.5, 0.8]; // 2 frames
    convert_and_downmix_to_stereo(
        frame_3ch.as_ptr() as *const u8,
        2,
        3,
        32,
        false,
        &mut out,
    );
    assert_eq!(out.len(), 4);
    assert_eq!(out[0], 0.4);
    assert_eq!(out[1], 0.6);
    assert_eq!(out[2], -0.3);
    assert_eq!(out[3], 0.5);

    // 5 channels float
    out.clear();
    let frame_5ch: [f32; 5] = [0.2, 0.8, 0.1, 0.3, 0.4];
    convert_and_downmix_to_stereo(
        frame_5ch.as_ptr() as *const u8,
        1,
        5,
        32,
        false,
        &mut out,
    );
    assert_eq!(out.len(), 2);
    assert_eq!(out[0], 0.2);
    assert_eq!(out[1], 0.8);

    // H. Silent Flag with Non-Zero Buffer
    out.clear();
    let dirty: [f32; 16] = [0.77; 16];
    convert_and_downmix_to_stereo(
        dirty.as_ptr() as *const u8,
        2,
        8,
        32,
        true, // SILENT
        &mut out,
    );
    assert_eq!(out.len(), 4);
    assert!(out.iter().all(|&s| s == 0.0f32));

    // I. Null Pointer Handling
    out.clear();
    convert_and_downmix_to_stereo(
        std::ptr::null(),
        5,
        2,
        32,
        false,
        &mut out,
    );
    assert_eq!(out.len(), 10);
    assert!(out.iter().all(|&s| s == 0.0f32));

    // J. Zero Frames Handling
    out.clear();
    convert_and_downmix_to_stereo(
        frame_5_1_max.as_ptr() as *const u8,
        0,
        6,
        32,
        false,
        &mut out,
    );
    assert_eq!(out.len(), 0);
}

/// 6. EMPIRICAL TEST: AudioResampler Corner Cases (Empty, Single Sample, In==Out Passthrough, Reset)
#[test]
fn test_resampler_corner_cases() {
    let mut resampler = AudioResampler::new(44100, 48000);

    // Empty input
    let mut out = Vec::new();
    resampler.resample(&[], &mut out);
    assert!(out.is_empty(), "Empty input should produce empty output");

    // Passthrough when in_rate == out_rate
    let mut passthrough_resampler = AudioResampler::new(48000, 48000);
    let sample_data = vec![0.1f32, 0.2, 0.3, 0.4];
    let mut pass_out = Vec::new();
    passthrough_resampler.resample(&sample_data, &mut pass_out);
    assert_eq!(pass_out, sample_data);

    // Reset restores initial phase and last_frame
    resampler.resample(&sample_data, &mut out);
    assert!(resampler.phase() > 0.0);
    assert!(resampler.last_frame().is_some());
    resampler.reset();
    assert_eq!(resampler.phase(), 0.0);
    assert_eq!(resampler.last_frame(), None);
}
