//! Hardware selection shares the existing H264 packet/transport contract.
use std::ffi::{c_char, c_void, CStr};
use std::ptr::NonNull;
use std::sync::{Arc, atomic::{AtomicU32, Ordering}};
use windows_capture_api::core::Interface;
use windows_capture_api::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};

extern "C" {
    fn p2_mf_create(device: *mut c_void, width: u32, height: u32, fps: u32, bitrate: u32,
        error: *mut c_char, size: usize) -> *mut c_void;
    fn p2_mf_encode(handle: *mut c_void, texture: *mut c_void, timestamp: u64, force_key: i32, bitrate: u32,
        bytes: *mut *const u8, len: *mut usize, timestamp_out: *mut u64, key: *mut i32, error: *mut c_char, size: usize) -> i32;
    fn p2_mf_destroy(handle: *mut c_void);
}
fn message(error: &[c_char; 256]) -> String {
    unsafe { CStr::from_ptr(error.as_ptr()).to_string_lossy().into_owned() }
}
struct MfSession { handle: NonNull<c_void>, device: ID3D11Device, width: u32, height: u32, fps: u32 }
// All calls, including COM destruction, stay on the owning WGC capture thread.
unsafe impl Send for MfSession {}
impl Drop for MfSession { fn drop(&mut self) { unsafe { p2_mf_destroy(self.handle.as_ptr()); } } }

pub struct GpuEncoder {
    nvenc: Option<crate::video_nvenc::GpuEncoder>,
    mf: Option<MfSession>,
    mf_allowed: bool,
    sequence: Arc<AtomicU32>,
    backend: u8,
}
impl GpuEncoder {
    pub fn new(nvenc: bool, mf: bool, sequence: Arc<AtomicU32>) -> Self {
        Self { nvenc: nvenc.then(|| crate::video_nvenc::GpuEncoder::with_sequence(sequence.clone())),
            mf: None, mf_allowed: mf, sequence, backend: 0 }
    }
    pub fn backend(&self) -> u8 { self.backend }
    pub fn encode(&mut self, device: &ID3D11Device, texture: &ID3D11Texture2D,
        width: u32, height: u32, fps: u32, bitrate: u32, timestamp: u64, force_key: bool) -> Result<Vec<u8>, String> {
        if let Some(nvenc) = self.nvenc.as_mut() {
            match nvenc.encode(device, texture, width, height, fps, bitrate, timestamp, force_key) {
                Ok(packet) => { self.backend = 1; return Ok(packet); }
                Err(error) => {
                    self.nvenc = None;
                    crate::logger::log_msg("WARN", "capture.hardware", &format!("NVENC unavailable; trying Windows hardware encoder: {error}"));
                    if !self.mf_allowed { return Err(error); }
                }
            }
        }
        if !self.mf_allowed { return Err("Hardware encoding is disabled".into()); }
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 || width > 8192 || height > 8192
            || !(15..=120).contains(&fps) || !(100_000..=50_000_000).contains(&bitrate) {
            return Err("Windows hardware encoder geometry, FPS or bitrate is invalid".into());
        }
        let recreate = self.mf.as_ref().map_or(true, |s| s.device != *device || s.width != width || s.height != height || s.fps != fps);
        let mut error = [0; 256];
        if recreate {
            self.mf = None;
            let handle = unsafe { p2_mf_create(device.as_raw(), width, height, fps, bitrate, error.as_mut_ptr(), error.len()) };
            self.mf = Some(MfSession { handle: NonNull::new(handle).ok_or_else(|| message(&error))?, device: device.clone(), width, height, fps });
        }
        let mut bytes = std::ptr::null(); let mut len = 0; let mut key = 0; let mut output_timestamp = 0;
        if unsafe { p2_mf_encode(self.mf.as_ref().unwrap().handle.as_ptr(), texture.as_raw(), timestamp,
            i32::from(force_key || recreate), bitrate, &mut bytes, &mut len, &mut output_timestamp, &mut key, error.as_mut_ptr(), error.len()) } != 1 {
            return Err(message(&error));
        }
        if bytes.is_null() || len == 0 || len > 16 * 1024 * 1024 { return Err("Windows hardware H264 output size invalid".into()); }
        self.backend = 3;
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        Ok(crate::video_nvenc::packet(unsafe { std::slice::from_raw_parts(bytes, len) }, width, height, sequence, output_timestamp, key != 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_capture_api::Win32::Graphics::Direct3D11::*;
    use windows_capture_api::Win32::Graphics::Dxgi::Common::*;
    fn texture(device: &ID3D11Device, width: u32, height: u32) -> ID3D11Texture2D {
        let pixels = [220u8, 40, 10, 255].repeat(width as usize * height as usize);
        let desc = D3D11_TEXTURE2D_DESC { Width: width, Height: height, MipLevels: 1, ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM, SampleDesc: DXGI_SAMPLE_DESC {Count: 1, Quality: 0},
            Usage: D3D11_USAGE_DEFAULT, ..Default::default() };
        let data = D3D11_SUBRESOURCE_DATA {pSysMem: pixels.as_ptr().cast(), SysMemPitch: width * 4, SysMemSlicePitch: 0};
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)).unwrap(); }
        texture.unwrap()
    }
    #[test]
    fn hardware_selection_rejects_software_adapters_and_invalid_limits() {
        let (device, _) = crate::test_support::software_d3d_device();
        let source = texture(&device, 320, 180);
        for (w,h,fps,bitrate) in [(0,180,60,2_000_000),(321,180,60,2_000_000),(320,180,0,2_000_000),(320,180,60,0),(320,180,60,2_000_000)] {
            let mut encoder = GpuEncoder::new(false, true, Arc::new(AtomicU32::new(0)));
            assert!(encoder.encode(&device,&source,w,h,fps,bitrate,0,true).is_err());
            assert!(encoder.mf.is_none());
        }
        let mut encoder = GpuEncoder::new(true, true, Arc::new(AtomicU32::new(0)));
        assert!(encoder.encode(&device,&source,320,180,60,2_000_000,0,true).is_err());
        assert!(encoder.nvenc.is_none());
    }
    #[test]
    #[ignore = "requires a D3D11 GPU and hardware Media Foundation H264 encoder; run explicitly"]
    fn hardware_mf_encodes_recreates_and_forces_recovery_keys() {
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let sequence = Arc::new(AtomicU32::new(0));
        let mut encoder = GpuEncoder::new(false, true, sequence.clone());
        let mut count = 0;
        for (w,h,fps) in [(320,180,60),(180,320,30),(1920,1080,60)] {
            let source = texture(&device,w,h);
            for index in 0..8u64 {
                let forced = index==0 || index==6;
                let bitrate = if index<4 {8_000_000} else {6_400_000};
                let packet = encoder.encode(&device,&source,w,h,fps,bitrate,index*1_000_000/u64::from(fps),forced).unwrap();
                count+=1;
                assert_eq!(&packet[..5],b"P2NV\x01");
                assert_eq!(u32::from_le_bytes(packet[16..20].try_into().unwrap()),count);
                assert_eq!(u64::from_le_bytes(packet[20..28].try_into().unwrap()),index*1_000_000/u64::from(fps));
                assert_eq!(packet[5],u8::from(forced), "Bitrate edits must preserve prediction without unnecessary recovery keys");
                assert!(packet[28..].starts_with(&[0,0,0,1]) || packet[28..].starts_with(&[0,0,1]));
                assert_eq!(encoder.backend(),3);
            }
        }
        assert_eq!(sequence.load(Ordering::Relaxed),24);
    }
}
