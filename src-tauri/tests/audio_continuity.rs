use p2sharer_lib::audio_loopback::{
    convert_and_downmix_encoded, drain_single_source_samples, mix_one_chunk, soft_clip_sample, AudioResampler,
    PcmEncoding,
};
use std::collections::VecDeque;

fn stereo_tone(frames: usize, rate: u32) -> Vec<f32> {
    let mut pcm = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        let value = (2.0 * std::f64::consts::PI * 997.0 * frame as f64 / rate as f64).sin() as f32 * 0.7;
        pcm.extend_from_slice(&[value, value]);
    }
    pcm
}

#[test]
fn jittered_wasapi_packets_keep_every_sample_in_order() {
    let input = stereo_tone(48000 * 10, 48000);
    let mut fifo = VecDeque::new();
    let mut resampler = AudioResampler::new(48000, 48000);
    let mut scratch = Vec::new();
    let mut pending = Vec::new();
    let mut transmitted = Vec::new();
    let packet_frames = [240, 960, 120, 480, 1440, 360, 720, 480];
    let mut offset = 0;
    let mut packet = 0;

    while offset < input.len() {
        let end = (offset + packet_frames[packet % packet_frames.len()] * 2).min(input.len());
        fifo.extend(input[offset..end].iter().copied());
        drain_single_source_samples(&mut fifo, 48000, &mut resampler, &mut scratch, &mut pending);
        while pending.len() >= 960 {
            transmitted.extend(pending.drain(..960));
        }
        offset = end;
        packet += 1;
    }
    transmitted.extend(pending);

    assert_eq!(transmitted.len(), input.len(), "capture must not insert silence or discard frames");
    assert_eq!(transmitted, input, "PCM must remain bit-exact across irregular packet sizes");
}

#[test]
fn resampling_is_independent_of_capture_packet_boundaries() {
    let input = stereo_tone(44100 * 5, 44100);
    let mut whole = Vec::new();
    AudioResampler::new(44100, 48000).resample(&input, &mut whole);

    let mut fifo = VecDeque::new();
    let mut resampler = AudioResampler::new(44100, 48000);
    let mut scratch = Vec::new();
    let mut packetized = Vec::new();
    let packet_frames = [1, 17, 441, 1024, 53, 211];
    let mut offset = 0;
    let mut packet = 0;

    while offset < input.len() {
        let end = (offset + packet_frames[packet % packet_frames.len()] * 2).min(input.len());
        fifo.extend(input[offset..end].iter().copied());
        drain_single_source_samples(&mut fifo, 44100, &mut resampler, &mut scratch, &mut packetized);
        offset = end;
        packet += 1;
    }

    assert_eq!(packetized.len(), whole.len());
    let peak_error = packetized.iter().zip(&whole).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(peak_error < 1e-6, "chunk boundaries altered PCM by {peak_error}");
}

#[test]
fn mixed_audio_soft_clipper_has_no_jump_at_piecewise_boundary() {
    let below = soft_clip_sample(1.25 - 0.0001);
    let above = soft_clip_sample(1.25 + 0.0001);
    assert!((above - below).abs() < 0.001, "soft clipper introduced a waveform step");
    assert!(above > below, "soft clipper must remain monotonic");
}

#[test]
fn integer_mix_formats_are_not_interpreted_as_float_bits() {
    let pcm32: [i32; 4] = [i32::MAX, i32::MIN, 1_073_741_824, -1_073_741_824];
    let mut output = Vec::new();
    convert_and_downmix_encoded(
        pcm32.as_ptr() as *const u8, 2, 2, 32, PcmEncoding::Integer, false, &mut output,
    );
    assert!((output[0] - 1.0).abs() < 1e-6);
    assert!((output[1] + 1.0).abs() < 1e-6);
    assert!((output[2] - 0.5).abs() < 1e-6);
    assert!((output[3] + 0.5).abs() < 1e-6);

    let pcm24: [u8; 6] = [0xff, 0xff, 0x7f, 0x00, 0x00, 0x80];
    output.clear();
    convert_and_downmix_encoded(
        pcm24.as_ptr(), 1, 2, 24, PcmEncoding::Integer, false, &mut output,
    );
    assert!((output[0] - 1.0).abs() < 1e-6);
    assert!((output[1] + 1.0).abs() < 1e-6);
}

#[test]
fn two_capture_sources_mix_without_wall_clock_padding() {
    let mut first = VecDeque::new();
    let mut second = VecDeque::new();
    let mut mixed = Vec::new();
    for _ in 0..101 {
        first.extend(std::iter::repeat_n(0.1f32, 960));
        second.extend(std::iter::repeat_n(0.1f32, 960));
        while first.len().max(second.len()) >= 1920 {
            mix_one_chunk(&mut [&mut first, &mut second], 480, &mut mixed);
        }
    }
    assert_eq!(mixed.len(), 100 * 960);
    let expected = 0.2f32 / 2.0f32.sqrt();
    assert!(mixed.iter().all(|&sample| (sample - expected).abs() < 1e-6));
}
