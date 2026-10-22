//! Monitor-only GPU capture. The owning thread retains all duplication/encoder resources.
use windows_capture_api::core::{s, Error, Interface, Result};
use windows_capture_api::Win32::Foundation::{E_INVALIDARG, E_POINTER, HMODULE};
use windows_capture_api::Win32::Graphics::{Direct3D::*, Direct3D11::*, Dxgi::{*, Common::*}};

const SHADER: &str = r#"
Texture2D<float4> desktop : register(t0);
Texture2D<uint4> pointer : register(t1);
cbuffer Params : register(b0) { int4 geometry; int4 cursor; int4 shape; };
float4 vs(uint id : SV_VertexID) : SV_POSITION {
    float2 uv = float2((id << 1) & 2, id & 2);
    return float4(uv.x * 2 - 1, 1 - uv.y * 2, 0, 1);
}
float4 ps(float4 position : SV_POSITION) : SV_TARGET {
    int2 p = int2(position.xy); int2 source = p;
    if (geometry.z == 2) source = int2(p.y, geometry.y - 1 - p.x);
    if (geometry.z == 3) source = geometry.xy - 1 - p;
    if (geometry.z == 4) source = int2(geometry.x - 1 - p.y, p.x);
    float4 color = desktop.Load(int3(source, 0));
    int2 cp = p - cursor.xy;
    if (cursor.z != 0 && all(cp >= 0) && all(cp < shape.xy)) {
        uint4 c = pointer.Load(int3(cp, 0));
        uint3 base = (uint3)round(saturate(color.rgb) * 255);
        if (shape.z == 1) color.rgb = ((base & c.aaa) ^ c.rgb) / 255.0;
        else if (shape.z == 4) color.rgb = (c.a == 0 ? c.rgb : (base ^ c.rgb)) / 255.0;
        else color.rgb = lerp(color.rgb, c.rgb / 255.0, c.a / 255.0);
    }
    return float4(color.rgb, 1);
}
"#;

struct DesktopImage {
    input: ID3D11Texture2D, view: ID3D11ShaderResourceView,
    output: ID3D11Texture2D, target: ID3D11RenderTargetView,
    desc: D3D11_TEXTURE2D_DESC,
}

struct Compositor {
    vertex: ID3D11VertexShader, pixel: ID3D11PixelShader, params: ID3D11Buffer,
    pointer: ID3D11ShaderResourceView, pointer_shape: [i32; 4],
    image: Option<DesktopImage>,
}

impl Compositor {
    fn new(device: &ID3D11Device) -> Result<Self> {
        let vs = crate::video_gpu_scale::compile_shader(SHADER, s!("vs"), s!("vs_4_0"))?;
        let ps = crate::video_gpu_scale::compile_shader(SHADER, s!("ps"), s!("ps_4_0"))?;
        let mut vertex = None; let mut pixel = None; let mut params = None;
        unsafe {
            device.CreateVertexShader(std::slice::from_raw_parts(vs.GetBufferPointer().cast(), vs.GetBufferSize()), None, Some(&mut vertex))?;
            device.CreatePixelShader(std::slice::from_raw_parts(ps.GetBufferPointer().cast(), ps.GetBufferSize()), None, Some(&mut pixel))?;
            device.CreateBuffer(&D3D11_BUFFER_DESC { ByteWidth: 48, Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32, ..Default::default() }, None, Some(&mut params))?;
        }
        let pointer = pointer_view(device, 1, 1, &[0; 4])?;
        Ok(Self { vertex: vertex.ok_or_else(|| Error::from_hresult(E_POINTER))?,
            pixel: pixel.ok_or_else(|| Error::from_hresult(E_POINTER))?,
            params: params.ok_or_else(|| Error::from_hresult(E_POINTER))?,
            pointer, pointer_shape: [0; 4], image: None })
    }

    fn set_pointer(&mut self, device: &ID3D11Device, info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO, bytes: &[u8]) -> Result<()> {
        let (height, pixels) = unpack_pointer(info, bytes)?;
        self.pointer = pointer_view(device, info.Width, height, &pixels)?;
        self.pointer_shape = [info.Width as i32, height as i32, info.Type as i32, 0];
        Ok(())
    }

    fn render(&mut self, device: &ID3D11Device, context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D, rotation: DXGI_MODE_ROTATION, cursor: [i32; 4]) -> Result<ID3D11Texture2D> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { source.GetDesc(&mut desc); }
        let (width, height) = oriented_size(desc.Width, desc.Height, rotation);
        if self.image.as_ref().is_none_or(|image| image.desc.Width != desc.Width || image.desc.Height != desc.Height || image.desc.Format != desc.Format) {
            let input_desc = D3D11_TEXTURE2D_DESC { Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32, CPUAccessFlags: 0, MiscFlags: 0, ..desc };
            let output_desc = D3D11_TEXTURE2D_DESC { Width: width, Height: height,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM, BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32, ..input_desc };
            let mut input = None; let mut output = None; let mut view = None; let mut target = None;
            unsafe {
                device.CreateTexture2D(&input_desc, None, Some(&mut input))?;
                device.CreateTexture2D(&output_desc, None, Some(&mut output))?;
                device.CreateShaderResourceView(input.as_ref().ok_or_else(|| Error::from_hresult(E_POINTER))?, None, Some(&mut view))?;
                device.CreateRenderTargetView(output.as_ref().ok_or_else(|| Error::from_hresult(E_POINTER))?, None, Some(&mut target))?;
            }
            self.image = Some(DesktopImage { input: input.unwrap(), output: output.unwrap(),
                view: view.unwrap(), target: target.unwrap(), desc });
        }
        let image = self.image.as_ref().unwrap();
        let data = [[desc.Width as i32, desc.Height as i32, rotation.0, 0], cursor, self.pointer_shape];
        unsafe {
            context.ClearState();
            context.CopyResource(&image.input, source);
            context.UpdateSubresource(&self.params, 0, None, data.as_ptr().cast(), 0, 0);
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&self.vertex, None);
            context.PSSetShader(&self.pixel, None);
            context.PSSetConstantBuffers(0, Some(&[Some(self.params.clone())]));
            context.PSSetShaderResources(0, Some(&[Some(image.view.clone()), Some(self.pointer.clone())]));
            context.OMSetRenderTargets(Some(&[Some(image.target.clone())]), None);
            context.RSSetViewports(Some(&[D3D11_VIEWPORT { Width: width as f32, Height: height as f32,
                MinDepth: 0.0, MaxDepth: 1.0, ..Default::default() }]));
            context.Draw(3, 0);
            context.ClearState();
        }
        Ok(image.output.clone())
    }
}

fn oriented_size(width: u32, height: u32, rotation: DXGI_MODE_ROTATION) -> (u32, u32) {
    if rotation == DXGI_MODE_ROTATION_ROTATE90 || rotation == DXGI_MODE_ROTATION_ROTATE270 { (height, width) } else { (width, height) }
}

fn pointer_view(device: &ID3D11Device, width: u32, height: u32, pixels: &[u8]) -> Result<ID3D11ShaderResourceView> {
    let desc = D3D11_TEXTURE2D_DESC { Width: width, Height: height, MipLevels: 1, ArraySize: 1,
        Format: DXGI_FORMAT_R8G8B8A8_UINT, SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_IMMUTABLE, BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32, ..Default::default() };
    let data = D3D11_SUBRESOURCE_DATA { pSysMem: pixels.as_ptr().cast(), SysMemPitch: width * 4, ..Default::default() };
    let mut texture = None; let mut view = None;
    unsafe {
        device.CreateTexture2D(&desc, Some(&data), Some(&mut texture))?;
        device.CreateShaderResourceView(texture.as_ref().ok_or_else(|| Error::from_hresult(E_POINTER))?, None, Some(&mut view))?;
    }
    view.ok_or_else(|| Error::from_hresult(E_POINTER))
}

// Only the small pointer bitmap crosses the CPU. Desktop pixels stay on the GPU.
fn unpack_pointer(info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO, bytes: &[u8]) -> Result<(u32, Vec<u8>)> {
    let mono = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32;
    let height = if mono { info.Height / 2 } else { info.Height };
    let pitch = info.Pitch as usize;
    if info.Width == 0 || height == 0 || info.Width > 4096 || info.Height > 8192 || (mono && info.Height % 2 != 0)
        || bytes.len() < pitch.saturating_mul(info.Height as usize)
        || pitch < if mono { (info.Width as usize).div_ceil(8) } else { info.Width as usize * 4 }
        || ![1, 2, 4].contains(&info.Type) { return Err(Error::from_hresult(E_INVALIDARG)); }
    let mut pixels = vec![0; info.Width as usize * height as usize * 4];
    for y in 0..height as usize { for x in 0..info.Width as usize {
        let out = &mut pixels[(y * info.Width as usize + x) * 4..][..4];
        if mono {
            let bit = 0x80 >> (x % 8);
            let and = if bytes[y * pitch + x/8] & bit != 0 { 255 } else { 0 };
            let xor = if bytes[(y + height as usize) * pitch + x/8] & bit != 0 { 255 } else { 0 };
            out.copy_from_slice(&[xor, xor, xor, and]);
        } else {
            let offset = y * pitch + x * 4;
            out.copy_from_slice(&[bytes[offset+2], bytes[offset+1], bytes[offset], bytes[offset+3]]);
        }
    } }
    Ok((height, pixels))
}

pub struct DesktopCapture {
    device: ID3D11Device, context: ID3D11DeviceContext, duplication: IDXGIOutputDuplication,
    compositor: Compositor, rotation: DXGI_MODE_ROTATION, width: u32, height: u32,
    cursor: [i32; 4], capture_mouse: bool, pointer_bytes: Vec<u8>,
}

impl DesktopCapture {
    pub fn new(monitor: usize, capture_mouse: bool) -> Result<Self> {
        // WGC can actually suppress a pointer embedded by the display driver.
        // Duplication cannot; preserve the user's hidden-cursor choice through WGC.
        if !capture_mouse { return Err(Error::from_hresult(E_INVALIDARG)); }
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
        for adapter_index in 0..64 {
            let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
                Ok(adapter) => adapter, Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break, Err(error) => return Err(error),
            };
            for output_index in 0..64 {
                let output = match unsafe { adapter.EnumOutputs(output_index) } {
                    Ok(output) => output, Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break, Err(error) => return Err(error),
                };
                let desc = unsafe { output.GetDesc()? };
                if desc.Monitor.0 as usize != monitor || !desc.AttachedToDesktop.as_bool() { continue; }
                let mut device = None; let mut context = None;
                unsafe { D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None,
                    D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))?; }
                let device = device.ok_or_else(|| Error::from_hresult(E_POINTER))?;
                let context = context.ok_or_else(|| Error::from_hresult(E_POINTER))?;
                let duplication = unsafe { output.cast::<IDXGIOutput1>()?.DuplicateOutput(&device)? };
                let compositor = Compositor::new(&device)?;
                let mode = unsafe { duplication.GetDesc() };
                let (width, height) = oriented_size(mode.ModeDesc.Width, mode.ModeDesc.Height, mode.Rotation);
                return Ok(Self { device, context, duplication, compositor, rotation: mode.Rotation,
                    width, height, cursor: [0; 4], capture_mouse, pointer_bytes: Vec::new() });
            }
        }
        Err(Error::from_hresult(DXGI_ERROR_NOT_FOUND))
    }

    pub fn device(&self) -> &ID3D11Device { &self.device }
    pub fn context(&self) -> &ID3D11DeviceContext { &self.context }
    pub fn dimensions(&self) -> (u32, u32) { (self.width, self.height) }

    pub fn next_frame(&mut self) -> Result<Option<ID3D11Texture2D>> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default(); let mut resource = None;
        match unsafe { self.duplication.AcquireNextFrame(50, &mut info, &mut resource) } {
            Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
            result => result?,
        }
        // Every successful acquire has exactly one release, even on conversion errors.
        let result = (|| {
            if info.LastMouseUpdateTime != 0 {
                self.cursor = [info.PointerPosition.Position.x, info.PointerPosition.Position.y,
                    i32::from(info.PointerPosition.Visible.as_bool() && self.capture_mouse), 0];
            }
            if info.PointerShapeBufferSize > 0 {
                if info.PointerShapeBufferSize > 64 * 1024 * 1024 { return Err(Error::from_hresult(E_INVALIDARG)); }
                self.pointer_bytes.resize(info.PointerShapeBufferSize as usize, 0);
                let mut required = 0; let mut shape = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                unsafe { self.duplication.GetFramePointerShape(info.PointerShapeBufferSize,
                    self.pointer_bytes.as_mut_ptr().cast(), &mut required, &mut shape)?; }
                self.compositor.set_pointer(&self.device, &shape, &self.pointer_bytes)?;
            }
            let texture = resource.ok_or_else(|| Error::from_hresult(E_POINTER))?.cast::<ID3D11Texture2D>()?;
            let output = self.compositor.render(&self.device, &self.context, &texture, self.rotation, self.cursor)?;
            // The acquired surface is unrotated; mode metadata can describe the
            // oriented display. Derive encoder dimensions from the actual output.
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { output.GetDesc(&mut desc); }
            (self.width, self.height) = (desc.Width, desc.Height);
            Ok(Some(output))
        })();
        let release = unsafe { self.duplication.ReleaseFrame() };
        result.and_then(|frame| release.map(|_| frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn software_device() -> (ID3D11Device, ID3D11DeviceContext) {
        let mut device = None; let mut context = None;
        unsafe { D3D11CreateDevice(None, D3D_DRIVER_TYPE_WARP, HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION,
            Some(&mut device), None, Some(&mut context)).unwrap(); }
        (device.unwrap(), context.unwrap())
    }

    fn image(device: &ID3D11Device) -> ID3D11Texture2D {
        // BGRA source: red/green above blue/white. Non-square catches rotation errors.
        let pixels: Vec<u8> = (0..32).flat_map(|i| match (i % 8 < 4, i / 8 < 2) {
            (true, true) => [0, 0, 255, 255], (false, true) => [0, 255, 0, 255],
            (true, false) => [255, 0, 0, 255], _ => [255, 255, 255, 255],
        }).collect();
        let desc = D3D11_TEXTURE2D_DESC { Width: 8, Height: 4, MipLevels: 1, ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM, SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT, ..Default::default() };
        let data = D3D11_SUBRESOURCE_DATA { pSysMem: pixels.as_ptr().cast(), SysMemPitch: 32, ..Default::default() };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)).unwrap(); }
        texture.unwrap()
    }

    #[test]
    fn gpu_compositor_preserves_colors_rotates_and_composites_all_pointer_types() {
        let (device, context) = software_device(); let source = image(&device);
        let mut compositor = Compositor::new(&device).unwrap();
        let mut readback = crate::video_readback::ReusableReadback::default();
        let r = [255,0,0,255]; let g = [0,255,0,255]; let b = [0,0,255,255]; let w = [255;4];
        for (rotation, expected) in [(DXGI_MODE_ROTATION_IDENTITY, [r,g,b,w]),
            (DXGI_MODE_ROTATION_ROTATE90, [b,r,w,g]),
            (DXGI_MODE_ROTATION_ROTATE180, [w,b,g,r]),
            (DXGI_MODE_ROTATION_ROTATE270, [g,w,r,b])] {
            // Rotation can change while geometry remains the same after recreation.
            compositor.image = None;
            let output = compositor.render(&device, &context, &source, rotation, [0;4]).unwrap();
            let (width,height) = oriented_size(8,4,rotation);
            let mapped = readback.read_texture(&device, &context, &output).unwrap();
            for ((x,y), expected) in [(0,0),(width-1,0),(0,height-1),(width-1,height-1)].into_iter().zip(expected) {
                let offset = y as usize * mapped.row_pitch() + x as usize*4;
                assert_eq!(&mapped.pixels()[offset..offset+4], expected, "rotation={rotation:?}");
            }
        }
        compositor.image = None;
        for (kind, height, pitch, bytes, expected) in [
            (2, 1, 4, vec![255,0,0,128], [127,0,128,255]),
            (4, 1, 4, vec![255,0,0,0], b),
            (4, 1, 4, vec![255,0,0,255], [255,0,255,255]),
            (1, 2, 1, vec![0x80,0x80], [0,255,255,255]),
            (1, 2, 1, vec![0,0], [0,0,0,255]),
        ] {
            let info = DXGI_OUTDUPL_POINTER_SHAPE_INFO { Type: kind, Width: 1, Height: height, Pitch: pitch, ..Default::default() };
            compositor.set_pointer(&device, &info, &bytes).unwrap();
            let output = compositor.render(&device, &context, &source, DXGI_MODE_ROTATION_IDENTITY, [0,0,1,0]).unwrap();
            let mapped = readback.read_texture(&device, &context, &output).unwrap();
            for (actual, expected) in mapped.pixels()[..4].iter().zip(expected) {
                assert!((*actual as i16 - expected as i16).abs() <= 1, "pointer kind={kind}");
            }
            drop(mapped);
            // Hidden and fully clipped pointers leave the desktop unchanged.
            for cursor in [[0,0,0,0], [-1,-1,1,0], [8,4,1,0]] {
                let output = compositor.render(&device, &context, &source, DXGI_MODE_ROTATION_IDENTITY, cursor).unwrap();
                let mapped = readback.read_texture(&device, &context, &output).unwrap();
                assert_eq!(&mapped.pixels()[..4], r);
            }
        }
    }

    #[test]
    fn rejects_truncated_or_unbounded_pointer_bitmaps() {
        let mut info = DXGI_OUTDUPL_POINTER_SHAPE_INFO { Type: 2, Width: 2, Height: 2, Pitch: 8, ..Default::default() };
        assert!(unpack_pointer(&info, &[0;15]).is_err());
        info.Width = 4097;
        assert!(unpack_pointer(&info, &[0;16]).is_err());
        info.Width = 2; info.Type = 7;
        assert!(unpack_pointer(&info, &[0;16]).is_err());
        info.Type = 1; info.Height = 3;
        assert!(unpack_pointer(&info, &[0;24]).is_err());
    }
}
