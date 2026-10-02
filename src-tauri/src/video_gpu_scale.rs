use windows_capture_api::core::{s, Error, Result, PCSTR};
use windows_capture_api::Win32::Foundation::{E_POINTER, E_INVALIDARG};
use windows_capture_api::Win32::Graphics::Direct3D::{ID3DBlob, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST};
use windows_capture_api::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows_capture_api::Win32::Graphics::Direct3D11::*;

const SHADER: &str = r#"
Texture2D<float4> image : register(t0);
struct Vertex { float4 position : SV_POSITION; float2 uv : TEXCOORD0; };
Vertex vs(uint id : SV_VertexID) {
    Vertex v; v.uv = float2((id << 1) & 2, id & 2);
    v.position = float4(v.uv.x * 2 - 1, 1 - v.uv.y * 2, 0, 1); return v;
}
float4 ps(Vertex v) : SV_TARGET {
    uint width, height; image.GetDimensions(width, height);
    float2 size = float2(width, height);
    float2 footprint = float2(abs(ddx(v.uv.x)), abs(ddy(v.uv.y))) * size;
    float2 lo = max(v.uv * size - footprint * 0.5, 0);
    float2 hi = min(v.uv * size + footprint * 0.5, size);
    float4 sum = 0;
    [loop] for (int y = (int)floor(lo.y); y < (int)ceil(hi.y); y++) {
        float wy = max(0, min(hi.y, y + 1) - max(lo.y, y));
        [loop] for (int x = (int)floor(lo.x); x < (int)ceil(hi.x); x++) {
            float wx = max(0, min(hi.x, x + 1) - max(lo.x, x));
            sum += image.Load(int3(x, y, 0)) * wx * wy;
        }
    }
    return sum / max((hi.x - lo.x) * (hi.y - lo.y), 0.00001);
}
"#;

fn compile(entry: PCSTR, profile: PCSTR) -> Result<ID3DBlob> {
    let mut code = None;
    unsafe { D3DCompile(SHADER.as_ptr().cast(), SHADER.len(), PCSTR::null(), None,
        None, entry, profile, 0, 0, &mut code, None)?; }
    code.ok_or_else(|| Error::from_hresult(E_POINTER))
}

struct Shaders { device: ID3D11Device, vertex: ID3D11VertexShader, pixel: ID3D11PixelShader }
struct Images {
    source_desc: D3D11_TEXTURE2D_DESC, width: u32, height: u32,
    input: ID3D11Texture2D, input_view: ID3D11ShaderResourceView,
    output: ID3D11Texture2D, output_view: ID3D11RenderTargetView,
}

/// Vendor-neutral area downscaling before CPU readback. Each session owns its resources.
#[derive(Default)]
pub struct GpuScaler { shaders: Option<Shaders>, images: Option<Images> }

impl GpuScaler {
    pub fn resize(&mut self, device: &ID3D11Device, context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D, width: u32, height: u32) -> Result<ID3D11Texture2D> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { source.GetDesc(&mut desc); }
        if width == 0 || height == 0 || width > desc.Width || height > desc.Height
            || desc.SampleDesc.Count != 1 || desc.ArraySize != 1 || desc.MipLevels != 1 {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        if self.shaders.as_ref().map_or(true, |shaders| shaders.device != *device) {
            let vs = compile(s!("vs"), s!("vs_4_0"))?;
            let ps = compile(s!("ps"), s!("ps_4_0"))?;
            let mut vertex = None; let mut pixel = None;
            unsafe {
                device.CreateVertexShader(std::slice::from_raw_parts(vs.GetBufferPointer().cast(), vs.GetBufferSize()), None, Some(&mut vertex))?;
                device.CreatePixelShader(std::slice::from_raw_parts(ps.GetBufferPointer().cast(), ps.GetBufferSize()), None, Some(&mut pixel))?;
            }
            self.shaders = Some(Shaders { device: device.clone(),
                vertex: vertex.ok_or_else(|| Error::from_hresult(E_POINTER))?,
                pixel: pixel.ok_or_else(|| Error::from_hresult(E_POINTER))? });
            self.images = None;
        }
        let recreate = self.images.as_ref().map_or(true, |images| images.width != width || images.height != height
            || images.source_desc.Width != desc.Width || images.source_desc.Height != desc.Height
            || images.source_desc.Format != desc.Format);
        if recreate {
            let input_desc = D3D11_TEXTURE2D_DESC { Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32, CPUAccessFlags: 0, MiscFlags: 0, ..desc };
            let output_desc = D3D11_TEXTURE2D_DESC { Width: width, Height: height,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32, ..input_desc };
            let mut input = None; let mut output = None;
            let mut input_view = None; let mut output_view = None;
            unsafe {
                device.CreateTexture2D(&input_desc, None, Some(&mut input))?;
                device.CreateTexture2D(&output_desc, None, Some(&mut output))?;
                device.CreateShaderResourceView(input.as_ref().ok_or_else(|| Error::from_hresult(E_POINTER))?, None, Some(&mut input_view))?;
                device.CreateRenderTargetView(output.as_ref().ok_or_else(|| Error::from_hresult(E_POINTER))?, None, Some(&mut output_view))?;
            }
            self.images = Some(Images { source_desc: desc, width, height,
                input: input.unwrap(), output: output.unwrap(),
                input_view: input_view.ok_or_else(|| Error::from_hresult(E_POINTER))?,
                output_view: output_view.ok_or_else(|| Error::from_hresult(E_POINTER))? });
        }
        let images = self.images.as_ref().unwrap();
        let shaders = self.shaders.as_ref().unwrap();
        // This is WGC's private capture device/context, never the game's render context.
        unsafe {
            context.ClearState();
            context.CopyResource(&images.input, source);
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&shaders.vertex, None);
            context.PSSetShader(&shaders.pixel, None);
            context.PSSetShaderResources(0, Some(&[Some(images.input_view.clone())]));
            context.OMSetRenderTargets(Some(&[Some(images.output_view.clone())]), None);
            context.RSSetViewports(Some(&[D3D11_VIEWPORT { Width: width as f32, Height: height as f32,
                MinDepth: 0.0, MaxDepth: 1.0, ..Default::default() }]));
            context.Draw(3, 0);
            context.ClearState();
        }
        Ok(images.output.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_readback::ReusableReadback;
    use windows_capture_api::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};

    #[test]
    fn downscales_landscape_portrait_and_odd_sizes_without_color_or_orientation_changes() {
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let mut scaler = GpuScaler::default(); let mut readback = ReusableReadback::default();
        for (width, height, target_w, target_h) in [(64, 32, 32, 16), (32, 64, 16, 32), (37, 19, 19, 9),
            (3840, 2160, 1920, 1080), (2160, 3840, 1080, 1920), (8, 8, 4, 4)] {
            let mut pixels = vec![0u8; width as usize * height as usize * 4];
            for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
                let x = index % width as usize; let y = index / width as usize;
                if width == 8 {
                    pixel.copy_from_slice(if (x+y)%2 == 0 { &[255,128,64,255] } else { &[0,0,0,255] });
                } else {
                    pixel.copy_from_slice(&[if x < width as usize/2 {240} else {20},
                        if y < height as usize/2 {220} else {10}, 30, 255]);
                }
            }
            let desc = D3D11_TEXTURE2D_DESC { Width: width, Height: height, MipLevels: 1, ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM, SampleDesc: DXGI_SAMPLE_DESC {Count: 1, Quality: 0},
                Usage: D3D11_USAGE_DEFAULT, ..Default::default() };
            let data = D3D11_SUBRESOURCE_DATA { pSysMem: pixels.as_ptr().cast(), SysMemPitch: width*4, SysMemSlicePitch: 0 };
            let mut source = None;
            unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut source)).unwrap(); }
            let source = source.unwrap();
            assert!(scaler.resize(&device, &context, &source, 0, target_h).is_err());
            assert!(scaler.resize(&device, &context, &source, width+1, height).is_err());
            let output = scaler.resize(&device, &context, &source, target_w, target_h).unwrap();
            let mapped = readback.read_texture(&device, &context, &output).unwrap();
            for (x,y,expected) in [(1,1,[240u8,220,30,255]), (target_w-2,target_h-2,[20,10,30,255])] {
                let offset = y as usize * mapped.row_pitch() + x as usize*4;
                if width == 8 {
                    for (actual, expected) in mapped.pixels()[offset..offset+4].iter().zip([128u8,64,32,255]) {
                        assert!((*actual as i16 - expected as i16).abs() <= 1);
                    }
                } else { assert_eq!(&mapped.pixels()[offset..offset+4], &expected); }
            }
        }
    }
}
