#[path = "../src/video_readback.rs"]
mod video_readback;
#[path = "../src/video_jpeg.rs"]
mod video_jpeg;

use std::time::Instant;
use video_readback::ReusableReadback;
use video_jpeg::RealtimeJpegEncoder;
use windows_capture_api::Win32::Graphics::Direct3D11::{D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT};
use windows_capture_api::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};

fn main() {
    let image = xcap::Monitor::all().unwrap().into_iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false)).unwrap().capture_image().unwrap();
    let (width, height) = image.dimensions();
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width, Height: height, MipLevels: 1, ArraySize: 1,
        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT, ..Default::default()
    };
    let data = D3D11_SUBRESOURCE_DATA { pSysMem: image.as_raw().as_ptr().cast(), SysMemPitch: width * 4, SysMemSlicePitch: 0 };
    let mut source = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut source)).unwrap(); }
    let source = source.unwrap();
    // Alternate variants to reduce warmup/order bias. All variants encode identical pixels.
    for round in 0..3 {
        for (reuse, copy) in [(false, true), (true, true), (true, false)] {
            let mut readback = ReusableReadback::default();
            let mut encoder = RealtimeJpegEncoder::new(90).unwrap();
            let mut packed = vec![0; width as usize * height as usize * 4];
            let mut stages = [0.0; 3];
            for iteration in 0..90 {
                if !reuse { readback = ReusableReadback::default(); }
                let start = Instant::now();
                let mapped = readback.read_texture(&device, &context, &source).unwrap();
                let map_time = start.elapsed().as_secs_f64();
                let packing = Instant::now();
                if copy {
                    for (src, dst) in mapped.pixels().chunks_exact(mapped.row_pitch())
                        .zip(packed.chunks_exact_mut(width as usize * 4)) {
                        dst.copy_from_slice(&src[..width as usize * 4]);
                    }
                }
                let packing_time = packing.elapsed().as_secs_f64();
                let jpeg = Instant::now();
                let bytes = if copy { encoder.encode_rgba(&packed, width, height).unwrap() }
                    else { encoder.encode_rgba_strided(mapped.pixels(), width, height, mapped.row_pitch()).unwrap() };
                assert!(bytes.len() > 4);
                if iteration >= 10 {
                    stages[0] += map_time;
                    stages[1] += packing_time;
                    stages[2] += jpeg.elapsed().as_secs_f64();
                }
            }
            println!("round={round}, reuse={reuse}, copy={copy}: map={:.3}, pack={:.3}, jpeg={:.3}, total={:.3} ms", stages[0]*1000.0/80.0, stages[1]*1000.0/80.0, stages[2]*1000.0/80.0, stages.iter().sum::<f64>()*1000.0/80.0);
        }
    }
}
