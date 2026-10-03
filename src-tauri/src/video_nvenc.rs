//! Optional driver-loaded GPU encoding; ownership is confined to one capture handler.
use std::ffi::{c_char, c_void, CStr};
use std::ptr::NonNull;
use windows_capture_api::core::Interface;
use windows_capture_api::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};

extern "C" {
    fn p2_nvenc_probe(error: *mut c_char, size: usize) -> i32;
    fn p2_nvenc_create(device: *mut c_void, width: u32, height: u32, fps: u32, bitrate: u32,
        error: *mut c_char, size: usize) -> *mut c_void;
    fn p2_nvenc_encode(handle: *mut c_void, texture: *mut c_void, timestamp: u64, force_key: i32,
        bytes: *mut *const u8, len: *mut usize, key: *mut i32, error: *mut c_char, size: usize) -> i32;
    fn p2_nvenc_destroy(handle: *mut c_void);
    fn p2_nvenc_bitrate(handle: *mut c_void, bitrate: u32, error: *mut c_char, size: usize) -> i32;
}
fn message(error: &[c_char; 256]) -> String {
    // The boundary always null-terminates errors within the supplied buffer.
    unsafe { CStr::from_ptr(error.as_ptr()).to_string_lossy().into_owned() }
}
pub fn probe() -> Result<(), String> {
    let mut error = [0; 256];
    if unsafe { p2_nvenc_probe(error.as_mut_ptr(), error.len()) } == 1 { Ok(()) }
    else { Err(message(&error)) }
}
struct Session { handle: NonNull<c_void>, device: ID3D11Device, width: u32, height: u32, fps: u32, bitrate: u32 }
// The WGC handler exclusively owns this synchronous encoder and never accesses it concurrently.
unsafe impl Send for Session {}
impl Drop for Session { fn drop(&mut self) { unsafe { p2_nvenc_destroy(self.handle.as_ptr()); } } }

#[derive(Default)]
pub struct GpuEncoder { session: Option<Session>, sequence: u32 }
impl GpuEncoder {
    pub fn encode(&mut self, device: &ID3D11Device, texture: &ID3D11Texture2D,
        width: u32, height: u32, fps: u32, bitrate: u32, timestamp: u64, force_key: bool) -> Result<Vec<u8>, String> {
        if width == 0 || height == 0 || width > 8192 || height > 8192 || !(15..=120).contains(&fps) || !(100_000..=50_000_000).contains(&bitrate) {
            return Err("NVENC geometry or FPS is invalid".into());
        }
        let mut error = [0; 256];
        let recreate = self.session.as_ref().map_or(true, |s| s.device != *device || s.width != width || s.height != height || s.fps != fps);
        if recreate {
            // Release the previous hardware session before consuming another driver slot.
            self.session = None;
            let handle = unsafe { p2_nvenc_create(device.as_raw(), width, height, fps, bitrate,
                error.as_mut_ptr(), error.len()) };
            self.session = Some(Session { handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
                device: device.clone(), width, height, fps, bitrate });
        }
        let session = self.session.as_mut().unwrap();
        if session.bitrate != bitrate {
            if unsafe { p2_nvenc_bitrate(session.handle.as_ptr(), bitrate, error.as_mut_ptr(), error.len()) } != 1 { return Err(message(&error)); }
            session.bitrate = bitrate;
        }
        let mut bytes = std::ptr::null(); let mut len = 0; let mut key = 0;
        let handle = self.session.as_ref().unwrap().handle.as_ptr();
        if unsafe { p2_nvenc_encode(handle, texture.as_raw(), timestamp, i32::from(force_key || recreate),
            &mut bytes, &mut len, &mut key, error.as_mut_ptr(), error.len()) } != 1 {
            return Err(message(&error));
        }
        if bytes.is_null() || len == 0 || len > 16 * 1024 * 1024 { return Err("NVENC output size invalid".into()); }
        self.sequence = self.sequence.wrapping_add(1);
        let mut packet = Vec::with_capacity(28 + len);
        packet.extend_from_slice(b"P2NV"); packet.push(1); packet.push(u8::from(key != 0)); packet.extend_from_slice(&[0, 0]);
        packet.extend_from_slice(&width.to_le_bytes()); packet.extend_from_slice(&height.to_le_bytes());
        packet.extend_from_slice(&self.sequence.to_le_bytes()); packet.extend_from_slice(&timestamp.to_le_bytes());
        // Driver bytes remain owned by this encoder until its next synchronous call.
        packet.extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, len) });
        Ok(packet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_capture_api::Win32::Graphics::Direct3D11::*;
    use windows_capture_api::Win32::Graphics::Dxgi::Common::*;
    fn texture(device: &ID3D11Device, width: u32, height: u32) -> ID3D11Texture2D {
        let pixels = vec![100u8; width as usize * height as usize * 4];
        let desc = D3D11_TEXTURE2D_DESC { Width: width, Height: height, MipLevels: 1, ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM, SampleDesc: DXGI_SAMPLE_DESC {Count: 1, Quality: 0},
            Usage: D3D11_USAGE_DEFAULT, ..Default::default() };
        let data = D3D11_SUBRESOURCE_DATA { pSysMem: pixels.as_ptr().cast(), SysMemPitch: width*4, SysMemSlicePitch: 0 };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)).unwrap(); }
        texture.unwrap()
    }
    #[test]
    fn rejects_invalid_limits_before_opening_a_driver_session() {
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let texture = texture(&device, 320, 180);
        let mut encoder = GpuEncoder::default();
        for (width, height, fps) in [(0,180,60),(320,0,60),(8193,180,60),(320,180,0),(320,180,121)] {
            assert!(encoder.encode(&device, &texture, width, height, fps, 15_000_000, 0, false).is_err());
            assert!(encoder.session.is_none());
        }
    }
    #[test]
    fn hardware_encodes_recreates_portrait_and_forces_recovery_keyframes() {
        // Opt-in hardware validation must fail, rather than silently pass, on this NVIDIA host.
        if std::env::var("P2SHARER_TEST_NVENC").as_deref() != Ok("1") { return; }
        probe().unwrap();
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let mut encoder = GpuEncoder::default();
        for (width, height, fps) in [(320,180,60),(180,320,30),(640,360,120)] {
            let source = texture(&device, width, height);
            for index in 0..4 {
                let packet = encoder.encode(&device, &source, width, height, fps, 15_000_000, index*1_000_000/u64::from(fps), index==3).unwrap();
                assert_eq!(&packet[..5], b"P2NV\x01");
                assert_eq!(packet[5], u8::from(index==0 || index==3));
                assert_eq!(u32::from_le_bytes(packet[8..12].try_into().unwrap()), width);
                assert_eq!(u32::from_le_bytes(packet[12..16].try_into().unwrap()), height);
                assert!(packet[28..].starts_with(&[0,0,0,1]) || packet[28..].starts_with(&[0,0,1]));
            }
        }
    }
    #[test]
    fn hardware_bitrate_edits_preserve_prediction_and_quality_fixture() {
        if std::env::var("P2SHARER_TEST_NVENC").as_deref() != Ok("1") { return; }
        use std::io::Write;
        let directory = std::env::var("P2SHARER_NVENC_QUALITY_DIR").ok().map(std::path::PathBuf::from);
        if let Some(directory) = &directory { std::fs::create_dir_all(directory).unwrap(); }
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let (width, height, fps) = (1280u32, 720u32, 60u32);
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height { for x in 0..width {
            let ink = x % 13 == 0 || y % 19 == 0 ||
                (x % 13 >= 3 && x % 13 < 10 && y % 19 >= 5 && y % 19 < 14 && (x + y) % 7 < 2);
            let value = if ink { 24u8 } else { 224u8 };
            pixels.extend_from_slice(&[value, value, value, 255]);
        } }
        if let Some(directory) = &directory { std::fs::write(directory.join("reference.rgba"), &pixels).unwrap(); }
        let desc = D3D11_TEXTURE2D_DESC { Width: width, Height: height, MipLevels: 1, ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM, SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT, ..Default::default() };
        let data = D3D11_SUBRESOURCE_DATA { pSysMem: pixels.as_ptr().cast(), SysMemPitch: width * 4, SysMemSlicePitch: 0 };
        let mut source = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut source)).unwrap(); }
        let source = source.unwrap();
        let mut output = directory.as_ref().map(|directory| std::fs::File::create(directory.join("detail.p2nv")).unwrap());
        let mut encoder = GpuEncoder::default();
        let start = std::time::Instant::now();
        for index in 0..361u64 {
            // Stable, detailed pixels isolate quality pulses from resizing or real source motion.
            // Budget-only edits and requested IDRs are deliberately independent.
            let bitrate = if index < 180 { 8_000_000 } else if index < 240 { 6_400_000 } else { 8_000_000 };
            let forced = index == 90 || index == 270;
            let packet = encoder.encode(&device, &source, width, height, fps, bitrate, index * 1_000_000 / u64::from(fps), forced).unwrap();
            assert_eq!(packet[5] != 0, index == 0 || forced, "Bitrate-only changes and elapsed GOP time must not force IDRs at frame {index}");
            if let Some(output) = &mut output { output.write_all(&(packet.len() as u32).to_le_bytes()).unwrap(); output.write_all(&packet).unwrap(); }
        }
        println!("Detailed NVENC 720p sequence: {} ms / 361 frames", start.elapsed().as_millis());
    }
    #[test]
    fn hardware_1080p_motion_quality_fixture() {
        motion_quality_fixture(false);
    }
    #[test]
    fn hardware_1080p_delivery_stalls_preserve_the_reference_chain() {
        motion_quality_fixture(true);
    }
    fn motion_quality_fixture(stalled_delivery: bool) {
        if std::env::var("P2SHARER_TEST_NVENC").as_deref() != Ok("1") { return; }
        use std::io::Write;
        let directory = std::env::var("P2SHARER_NVENC_QUALITY_DIR").ok().map(std::path::PathBuf::from);
        if let Some(directory) = &directory { std::fs::create_dir_all(directory).unwrap(); }
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let (width, height, fps) = (1920u32, 1080u32, 60u32);
        let source = texture(&device, width, height);
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let filename = if stalled_delivery { "delivery1080.p2nv" } else { "motion1080.p2nv" };
        let mut output = directory.as_ref().map(|dir| std::fs::File::create(dir.join(filename)).unwrap());
        let mut encoder = GpuEncoder::default();
        let mut pacer = crate::video_pacer::FramePacer::<Vec<u8>>::new(fps);
        let mut sequence = 0u32;
        let mut admitted = 0;
        let mut emitted = 0;
        for index in 0..610u64 {
            let now = (index * 1_000_000).div_ceil(u64::from(fps));
            if stalled_delivery && ![90,91,92,180,181,182,270,271,272].contains(&index) {
                if let Some(crate::video_pacer::PacedFrame::Fresh {frame,..}) = pacer.tick(now) {
                    let next = u32::from_le_bytes(frame[16..20].try_into().unwrap());
                    assert_eq!(next, sequence + 1); sequence = next; emitted += 1;
                    assert_eq!(frame[5] != 0, emitted == 1);
                    if let Some(output) = &mut output { output.write_all(&(frame.len() as u32).to_le_bytes()).unwrap(); output.write_all(&frame).unwrap(); }
                }
            }
            if index >= 601 || stalled_delivery && !pacer.has_encode_capacity() { continue; }
            for y in 0..height { for x in 0..width {
                let value = if y < 192 {
                    let ink = x % 13 == 0 || y % 19 == 0 ||
                        (x % 13 >= 3 && x % 13 < 10 && y % 19 >= 5 && y % 19 < 14 && (x + y) % 7 < 2);
                    if ink { 24 } else { 224 }
                } else {
                    // Moving spatial detail changes encoding cost while the top text stays fixed.
                    let shifted = x + index as u32 * 11;
                    if (shifted / 16 + y / 16) % 2 == 0 { 48 } else { 176 }
                };
                let offset = ((y * width + x) * 4) as usize;
                pixels[offset..offset + 4].copy_from_slice(&[value, value, value, 255]);
            } }
            unsafe { context.UpdateSubresource(&source, 0, None, pixels.as_ptr().cast(), width * 4, 0); }
            let packet = encoder.encode(&device, &source, width, height, fps, 15_000_000,
                index * 1_000_000 / u64::from(fps), false).unwrap();
            admitted += 1;
            assert_eq!(packet[5] != 0, admitted == 1);
            if stalled_delivery { assert!(pacer.enqueue_dependent(packet, now)); }
            else if let Some(output) = &mut output { output.write_all(&(packet.len() as u32).to_le_bytes()).unwrap(); output.write_all(&packet).unwrap(); }
        }
        if stalled_delivery { assert_eq!(admitted, emitted); assert!(admitted < 601 && admitted > 570, "Admitted {admitted} source pictures"); assert_eq!(pacer.dropped, 0); }
    }
    #[test]
    fn software_capture_device_returns_an_error_instead_of_assuming_vendor_support() {
        use windows_capture_api::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;
        let mut device = None;
        unsafe { D3D11CreateDevice(None, D3D_DRIVER_TYPE_WARP, windows_capture_api::Win32::Foundation::HMODULE::default(), D3D11_CREATE_DEVICE_FLAG(0), None,
            D3D11_SDK_VERSION, Some(&mut device), None, None).unwrap(); }
        let device = device.unwrap(); let texture = texture(&device, 320, 180);
        let mut encoder = GpuEncoder::default();
        assert!(encoder.encode(&device, &texture, 320, 180, 60, 15_000_000, 0, false).is_err());
        assert!(encoder.session.is_none());
    }
}
