use windows_capture::frame::{Frame, FrameBuffer};
use windows_capture_api::core::{Error, Result};
use windows_capture_api::Win32::Foundation::E_POINTER;
use windows_capture_api::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE, D3D11_MAP_READ_WRITE, D3D11_MAPPED_SUBRESOURCE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};

/// A session-owned readback texture, recreated only when source geometry/device changes.
#[derive(Default)]
pub struct ReusableReadback {
    staging: Option<(ID3D11Device, ID3D11Texture2D, D3D11_TEXTURE2D_DESC)>,
    allocations: u64,
}

impl ReusableReadback {
    pub fn allocations(&self) -> u64 { self.allocations }

    pub fn read<'a>(&'a mut self, frame: &Frame<'_>) -> Result<MappedReadback<'a>> {
        self.read_texture(frame.device(), frame.device_context(), frame.as_raw_texture())
    }

    pub fn read_texture<'a>(
        &'a mut self, device: &ID3D11Device, context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
    ) -> Result<MappedReadback<'a>> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { source.GetDesc(&mut desc); }
        let recreate = self.staging.as_ref().map_or(true, |(previous_device, _, previous)| {
            previous_device != device || previous.Width != desc.Width || previous.Height != desc.Height
                || previous.Format != desc.Format || previous.SampleDesc != desc.SampleDesc
                || previous.MipLevels != desc.MipLevels || previous.ArraySize != desc.ArraySize
        });
        if recreate {
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_STAGING, BindFlags: 0,
                CPUAccessFlags: (D3D11_CPU_ACCESS_READ.0 | D3D11_CPU_ACCESS_WRITE.0) as u32, MiscFlags: 0,
                ..desc
            };
            let mut texture = None;
            unsafe { device.CreateTexture2D(&staging_desc, None, Some(&mut texture))?; }
            self.staging = Some((device.clone(), texture.ok_or_else(|| Error::from_hresult(E_POINTER))?, desc));
            self.allocations += 1;
        }
        let texture = &self.staging.as_ref().unwrap().1;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context.CopyResource(texture, source);
            context.Map(texture, 0, D3D11_MAP_READ_WRITE, 0, Some(&mut mapped))?;
        }
        Ok(MappedReadback { context: context.clone(), texture, mapped, height: desc.Height })
    }
}

/// The borrow prevents reusing the staging texture while its pixels are mapped.
pub struct MappedReadback<'a> {
    context: ID3D11DeviceContext,
    texture: &'a ID3D11Texture2D,
    mapped: D3D11_MAPPED_SUBRESOURCE,
    height: u32,
}

impl MappedReadback<'_> {
    pub fn row_pitch(&self) -> usize { self.mapped.RowPitch as usize }

    pub fn pixels(&self) -> &[u8] {
        // D3D11 keeps RowPitch * Height bytes accessible until this guard unmaps them.
        unsafe { std::slice::from_raw_parts(self.mapped.pData.cast(), self.row_pitch() * self.height as usize) }
    }

    fn pixels_mut(&mut self) -> &mut [u8] {
        let len = self.row_pitch() * self.height as usize;
        // The guard has exclusive access to the mapped read/write texture.
        unsafe { std::slice::from_raw_parts_mut(self.mapped.pData.cast(), len) }
    }
}

impl Drop for MappedReadback<'_> {
    fn drop(&mut self) {
        unsafe { self.context.Unmap(self.texture, 0); }
    }
}

/// The legacy path remains available for controlled comparisons and driver recovery.
pub enum CapturePixels<'a> {
    Reused(MappedReadback<'a>),
    Legacy(FrameBuffer<'a>),
}

impl CapturePixels<'_> {
    pub fn packed<'a>(&'a mut self, destination: &'a mut Vec<u8>, width: u32, height: u32) -> &'a [u8] {
        match self {
            Self::Legacy(buffer) => buffer.as_nopadding_buffer(destination),
            Self::Reused(buffer) => {
                let row_bytes = width as usize * 4;
                if buffer.row_pitch() == row_bytes { return buffer.pixels(); }
                // Preserve the library's parallel packing and no-copy behavior.
                let pitch = buffer.row_pitch() as u32;
                let depth = buffer.mapped.DepthPitch;
                let view = FrameBuffer::new(buffer.pixels_mut(), width, height, pitch, depth,
                    windows_capture::settings::ColorFormat::Rgba8);
                let _ = view.as_nopadding_buffer(destination);
                destination
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_capture_api::Win32::Graphics::Direct3D11::{D3D11_SUBRESOURCE_DATA, D3D11_USAGE_DEFAULT};
    use windows_capture_api::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};

    #[test]
    fn reuses_unmapped_texture_and_recreates_for_portrait_and_size_changes() {
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let mut readback = ReusableReadback::default();
        for (width, height, expected_allocations) in [(37, 19, 1), (37, 19, 1), (19, 37, 2), (64, 32, 3)] {
            let pixels = [230u8, 20, 10, 255].repeat((width * height) as usize);
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width, Height: height, MipLevels: 1, ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT, ..Default::default()
            };
            let data = D3D11_SUBRESOURCE_DATA { pSysMem: pixels.as_ptr().cast(), SysMemPitch: width * 4, SysMemSlicePitch: 0 };
            let mut texture = None;
            unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)).unwrap(); }
            let mapped = readback.read_texture(&device, &context, &texture.unwrap()).unwrap();
            for row in mapped.pixels().chunks_exact(mapped.row_pitch()) {
                assert_eq!(&row[..width as usize * 4], &pixels[..width as usize * 4]);
            }
            let mut captured = CapturePixels::Reused(mapped);
            let mut packed = Vec::new();
            assert_eq!(captured.packed(&mut packed, width, height), pixels.as_slice());
            drop(captured);
            assert_eq!(readback.allocations(), expected_allocations);
        }
    }
}
