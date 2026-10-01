#[path = "../src/video_jpeg.rs"]
mod video_jpeg;

use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use std::time::Instant;

fn main() {
    let monitor = xcap::Monitor::all().unwrap().into_iter().find(|m| m.is_primary().unwrap_or(false)).unwrap();
    let image = monitor.capture_image().unwrap();
    let pixels = image.as_raw();
    let (width, height) = image.dimensions();
    let mut turbo = video_jpeg::RealtimeJpegEncoder::new(90).unwrap();
    let mut output = Vec::new();
    for kind in ["jpeg-encoder", "libjpeg-turbo"] {
        let start = Instant::now();
        for _ in 0..60 {
            if kind == "libjpeg-turbo" {
                output = turbo.encode_rgba(pixels, width, height).unwrap();
            } else {
                output.clear();
                let mut encoder = Encoder::new(&mut output, 90);
                encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
                encoder.encode(pixels, width as u16, height as u16, ColorType::Rgba).unwrap();
            }
        }
        println!("{kind}: {width}x{height}, {:.2} ms/frame, {} bytes", start.elapsed().as_secs_f64() * 1000.0 / 60.0, output.len());
    }
}
