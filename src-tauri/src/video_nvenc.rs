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
