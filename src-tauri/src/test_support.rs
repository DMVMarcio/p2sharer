//! Software rendering fixtures for device-independent native regressions.
use windows_capture_api::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;
use windows_capture_api::Win32::Graphics::Direct3D11::*;

pub(crate) fn software_d3d_device() -> (ID3D11Device, ID3D11DeviceContext) {
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None, D3D_DRIVER_TYPE_WARP,
            windows_capture_api::Win32::Foundation::HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0), None, D3D11_SDK_VERSION,
            Some(&mut device), None, Some(&mut context),
        ).expect("Windows WARP software rendering fixture");
    }
    (device.unwrap(), context.unwrap())
}
