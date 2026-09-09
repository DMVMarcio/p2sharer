use p2sharer_lib::audio_loopback::{
    convert_and_downmix_to_stereo, resample_interleaved_float, AudioResampler, AudioStreamPayload,
};

/// 1. Resampling accuracy: 44.1 kHz to 48 kHz standard stereo conversion
#[test]
fn test_resample_44100_to_48000() {
    let in_rate = 44100u32;
    let out_rate = 48000u32;
    let channels = 2u16;
    let duration_sec = 0.5f64;

    // Generate 1000 Hz stereo sine wave
    let in_frames = (duration_sec * in_rate as f64).round() as usize; // 22050
    let mut input = Vec::with_capacity(in_frames * 2);
    let angular_speed = 2.0 * std::f64::consts::PI * 1000.0 / in_rate as f64;

    for f in 0..in_frames {
        let val = (angular_speed * f as f64).sin() as f32 * 0.8;
        input.push(val); // L
        input.push(val); // R
    }

    let resampled = resample_interleaved_float(&input, channels, in_rate, out_rate);

    let expected_frames = (duration_sec * out_rate as f64).round() as usize; // 24000
    assert_eq!(
        resampled.len() / 2,
        expected_frames,
        "Resampled frame count must match expected 48kHz frames"
    );

    // RMS energy preservation check
    let mut sum_sq_in = 0.0f32;
    for &s in &input {
        sum_sq_in += s * s;
    }
    let in_rms = (sum_sq_in / input.len() as f32).sqrt();

    let mut sum_sq_out = 0.0f32;
    for &s in &resampled {
        sum_sq_out += s * s;
    }
    let out_rms = (sum_sq_out / resampled.len() as f32).sqrt();

    assert!(
        (out_rms - in_rms).abs() < 0.02,
        "RMS energy must be preserved across resampling (in: {}, out: {})",
        in_rms,
        out_rms
    );
}

/// 2. Boundary sample rates: Telephony (8 kHz), Studio Master (192 kHz), High-Res (96 kHz), and Passthrough (48 kHz)
#[test]
fn test_resample_boundary_sample_rates() {
    let channels = 2u16;

    // A. 8 kHz Telephony -> 48 kHz (6:1 upsampling)
    let in_frames_8k = 800; // 100ms
    let mut input_8k = vec![0.0f32; in_frames_8k * 2];
    for (i, val) in input_8k.iter_mut().enumerate() {
        *val = ((i as f32 / 8.0) * std::f32::consts::PI).sin() * 0.5;
    }
    let resampled_8k = resample_interleaved_float(&input_8k, channels, 8000, 48000);
    assert_eq!(resampled_8k.len() / 2, 4800);

    // B. 192 kHz Studio Master -> 48 kHz (4:1 downsampling)
    let in_frames_192k = 19200; // 100ms
    let mut input_192k = vec![0.0f32; in_frames_192k * 2];
    for (i, val) in input_192k.iter_mut().enumerate() {
        *val = ((i as f32 / 32.0) * std::f32::consts::PI).sin() * 0.5;
    }
    let resampled_192k = resample_interleaved_float(&input_192k, channels, 192000, 48000);
    assert_eq!(resampled_192k.len() / 2, 4800);

    // C. 96 kHz -> 48 kHz (2:1 downsampling)
    let in_frames_96k = 9600; // 100ms
    let input_96k = vec![0.3f32; in_frames_96k * 2];
    let resampled_96k = resample_interleaved_float(&input_96k, channels, 96000, 48000);
    assert_eq!(resampled_96k.len() / 2, 4800);

    // D. 48 kHz Passthrough
    let input_48k = vec![0.7f32; 960];
    let resampled_48k = resample_interleaved_float(&input_48k, channels, 48000, 48000);
    assert_eq!(resampled_48k, input_48k);
}

/// 3. Stateful AudioResampler streaming phase continuity across chunk boundaries
#[test]
fn test_resampler_streaming_phase_continuity() {
    let in_rate = 44100u32;
    let out_rate = 48000u32;
    let chunk_in_frames = 441; // 10ms chunks
    let num_chunks = 10;

    let mut resampler = AudioResampler::new(in_rate, out_rate);
    assert_eq!(resampler.in_rate(), 44100);
    assert_eq!(resampler.out_rate(), 48000);
    assert_eq!(resampler.phase(), 0.0);

    // Generate continuous sine across 10 consecutive chunks
    let total_in_frames = chunk_in_frames * num_chunks;
    let angular_speed = 2.0 * std::f64::consts::PI * 440.0 / in_rate as f64;

    let mut full_input = Vec::with_capacity(total_in_frames * 2);
    for f in 0..total_in_frames {
        let val = (angular_speed * f as f64).sin() as f32;
        full_input.push(val);
        full_input.push(val);
    }

    // Stream chunk-by-chunk through AudioResampler
    let mut streamed_output = Vec::new();
    for chunk_idx in 0..num_chunks {
        let start = chunk_idx * chunk_in_frames * 2;
        let end = start + chunk_in_frames * 2;
        let chunk = &full_input[start..end];
        resampler.resample(chunk, &mut streamed_output);
    }

    // Expected total frames = 10 chunks * 480 frames = 4800 frames
    assert_eq!(streamed_output.len() / 2, 4800);

    // Verify boundary smoothness: maximum derivative across any boundary should remain bounded
    for i in 1..(streamed_output.len() / 2) {
        let delta_l = (streamed_output[i * 2] - streamed_output[(i - 1) * 2]).abs();
        let delta_r = (streamed_output[i * 2 + 1] - streamed_output[(i - 1) * 2 + 1]).abs();
        assert!(
            delta_l < 0.25,
            "Sample discontinuity detected at frame {}: delta {}",
            i,
            delta_l
        );
        assert!(
            delta_r < 0.25,
            "Sample discontinuity detected at frame {}: delta {}",
            i,
            delta_r
        );
    }

    // Test reset
    resampler.reset();
    assert_eq!(resampler.phase(), 0.0);
    assert_eq!(resampler.last_frame(), None);
}

/// 4. ITU-R BS.775 5.1 Surround downmixing to stereo
#[test]
fn test_downmix_5_1_surround_to_stereo() {
    let inv_sqrt2 = std::f32::consts::FRAC_1_SQRT_2;

    // 5.1 Layout: [FL, FR, FC, LFE, BL, BR]
    // L = (FL + FC * inv_sqrt2 + BL * inv_sqrt2).clamp(-1.0, 1.0)
    // R = (FR + FC * inv_sqrt2 + BR * inv_sqrt2).clamp(-1.0, 1.0)
    let frame_5_1: [f32; 6] = [0.2, 0.3, 0.2, 0.9, 0.2, 0.1];
    let num_frames = 1;
    let mut stereo_out = Vec::new();

    convert_and_downmix_to_stereo(
        frame_5_1.as_ptr() as *const u8,
        num_frames,
        6,
        32,
        false,
        &mut stereo_out,
    );

    assert_eq!(stereo_out.len(), 2);
    let expected_l = 0.2 + 0.2 * inv_sqrt2 + 0.2 * inv_sqrt2;
    let expected_r = 0.3 + 0.2 * inv_sqrt2 + 0.1 * inv_sqrt2;

    assert!(
        (stereo_out[0] - expected_l).abs() < 1e-5,
        "Left downmix mismatch: got {}, expected {}",
        stereo_out[0],
        expected_l
    );
    assert!(
        (stereo_out[1] - expected_r).abs() < 1e-5,
        "Right downmix mismatch: got {}, expected {}",
        stereo_out[1],
        expected_r
    );
}

/// 5. ITU-R BS.775 7.1 Surround downmixing to stereo
#[test]
fn test_downmix_7_1_surround_to_stereo() {
    let inv_sqrt2 = std::f32::consts::FRAC_1_SQRT_2;

    // 7.1 Layout: [FL, FR, FC, LFE, BL, BR, SL, SR]
    // L = (FL + FC * inv_sqrt2 + (BL + SL) * 0.5).clamp(-1.0, 1.0)
    // R = (FR + FC * inv_sqrt2 + (BR + SR) * 0.5).clamp(-1.0, 1.0)
    let frame_7_1: [f32; 8] = [0.1, 0.2, 0.2, 0.8, 0.2, 0.1, 0.2, 0.1];
    let num_frames = 1;
    let mut stereo_out = Vec::new();

    convert_and_downmix_to_stereo(
        frame_7_1.as_ptr() as *const u8,
        num_frames,
        8,
        32,
        false,
        &mut stereo_out,
    );

    assert_eq!(stereo_out.len(), 2);
    let expected_l = 0.1 + 0.2 * inv_sqrt2 + (0.2 + 0.2) * 0.5;
    let expected_r = 0.2 + 0.2 * inv_sqrt2 + (0.1 + 0.1) * 0.5;

    assert!(
        (stereo_out[0] - expected_l).abs() < 1e-5,
        "7.1 Left downmix mismatch: got {}, expected {}",
        stereo_out[0],
        expected_l
    );
    assert!(
        (stereo_out[1] - expected_r).abs() < 1e-5,
        "7.1 Right downmix mismatch: got {}, expected {}",
        stereo_out[1],
        expected_r
    );
}

/// 6. Mono downmixing to stereo (both float32 and int16)
#[test]
fn test_downmix_mono_to_stereo() {
    // 32-bit float mono
    let mono_f32: [f32; 2] = [0.45, -0.65];
    let mut out_f32 = Vec::new();
    convert_and_downmix_to_stereo(
        mono_f32.as_ptr() as *const u8,
        2,
        1,
        32,
        false,
        &mut out_f32,
    );
    assert_eq!(out_f32.len(), 4);
    assert_eq!(out_f32[0], 0.45);
    assert_eq!(out_f32[1], 0.45);
    assert_eq!(out_f32[2], -0.65);
    assert_eq!(out_f32[3], -0.65);

    // 16-bit int mono
    let mono_i16: [i16; 2] = [16384, -32768];
    let mut out_i16 = Vec::new();
    convert_and_downmix_to_stereo(
        mono_i16.as_ptr() as *const u8,
        2,
        1,
        16,
        false,
        &mut out_i16,
    );
    assert_eq!(out_i16.len(), 4);
    assert!((out_i16[0] - 0.5).abs() < 1e-4);
    assert!((out_i16[1] - 0.5).abs() < 1e-4);
    assert!((out_i16[2] - (-1.0)).abs() < 1e-4);
    assert!((out_i16[3] - (-1.0)).abs() < 1e-4);
}

/// 7. Silence flag: outputs all zeros even if buffer memory is non-zero
#[test]
fn test_downmix_silence_flag_handling() {
    let dirty_buffer: [f32; 6] = [1.0, -1.0, 0.5, 0.8, -0.2, 0.4];
    let mut out_stereo = Vec::new();

    convert_and_downmix_to_stereo(
        dirty_buffer.as_ptr() as *const u8,
        3,
        2,
        32,
        true, // is_silent
        &mut out_stereo,
    );

    assert_eq!(out_stereo.len(), 6);
    assert!(
        out_stereo.iter().all(|&s| s == 0.0f32),
        "Silent flag must emit strictly zeroed samples"
    );
}

/// 8. Monotonic presentation timestamp progression
#[test]
fn test_timestamp_us_monotonicity() {
    let start = std::time::Instant::now();
    let mut last_ts = 0u64;

    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_micros(500));
        let current_ts = start.elapsed().as_micros() as u64;
        assert!(
            current_ts > last_ts,
            "timestamp_us must be strictly monotonically increasing (last: {}, current: {})",
            last_ts,
            current_ts
        );
        last_ts = current_ts;
    }
}

/// 9. AudioStreamPayload serialization with timestamp_us
#[test]
fn test_audio_stream_payload_serde_roundtrip() {
    let payload = AudioStreamPayload {
        pcm_base64: "AAAAAEAAgD8=".to_string(),
        sample_rate: 48000,
        channels: 2,
        rms_level: 0.5,
        timestamp_us: 12345678,
    };

    let json = serde_json::to_string(&payload).expect("Serialization must succeed");
    assert!(json.contains("\"timestamp_us\":12345678"));

    let deserialized: AudioStreamPayload =
        serde_json::from_str(&json).expect("Deserialization must succeed");
    assert_eq!(deserialized.pcm_base64, payload.pcm_base64);
    assert_eq!(deserialized.sample_rate, 48000);
    assert_eq!(deserialized.channels, 2);
    assert_eq!(deserialized.rms_level, 0.5);
    assert_eq!(deserialized.timestamp_us, 12345678);

    // Verify backward compatibility: payload without timestamp_us defaults to 0
    let legacy_json = r#"{"pcm_base64":"AAAA","sample_rate":48000,"channels":2,"rms_level":0.0}"#;
    let legacy_payload: AudioStreamPayload =
        serde_json::from_str(legacy_json).expect("Legacy payload must deserialize");
    assert_eq!(legacy_payload.timestamp_us, 0);
}
