use turbojpeg::{Compressor, Image, PixelFormat, Subsamp};

/// Persistent local JPEG encoder shared by WGC and the automatic xcap fallback.
pub struct RealtimeJpegEncoder {
    compressor: Compressor,
    output: Vec<u8>,
}

impl RealtimeJpegEncoder {
    pub fn new(quality: u8) -> turbojpeg::Result<Self> {
        let mut compressor = Compressor::new()?;
        compressor.set_quality(quality as i32)?;
        compressor.set_subsamp(Subsamp::Sub2x2)?;
        compressor.set_optimize(false)?;
        Ok(Self { compressor, output: Vec::new() })
    }

    pub fn encode_rgba(&mut self, pixels: &[u8], width: u32, height: u32) -> turbojpeg::Result<Vec<u8>> {
        self.encode_rgba_strided(pixels, width, height, width as usize * 4)
    }

    /// Encode mapped GPU rows directly without packing away their alignment padding.
    pub fn encode_rgba_strided(&mut self, pixels: &[u8], width: u32, height: u32, pitch: usize) -> turbojpeg::Result<Vec<u8>> {
        let width = width as usize;
        let height = height as usize;
        let capacity = self.compressor.buf_len(width, height)?;
        if self.output.len() < capacity {
            self.output.resize(capacity, 0);
        }
        let image = Image { pixels, width, pitch, height, format: PixelFormat::RGBA };
        let len = self.compressor.compress_to_slice(image, &mut self.output)?;
        Ok(self.output[..len].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padded_rows_encode_identically_to_packed_rows() {
        let mut encoder = RealtimeJpegEncoder::new(90).unwrap();
        for (width, height) in [(37u32, 19u32), (19, 37)] {
            let packed = [230u8, 20, 10, 255].repeat((width * height) as usize);
            let pitch = width as usize * 4 + 64;
            let mut padded = vec![99; pitch * height as usize];
            for row in padded.chunks_exact_mut(pitch) { row[..width as usize * 4].copy_from_slice(&packed[..width as usize * 4]); }
            let expected = encoder.encode_rgba(&packed, width, height).unwrap();
            let actual = encoder.encode_rgba_strided(&padded, width, height, pitch).unwrap();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn preserves_rgba_color_order_and_reuses_encoder_across_sizes() {
        let mut encoder = RealtimeJpegEncoder::new(90).unwrap();
        for (width, height, color) in [(32, 18, [230, 20, 10, 255]), (64, 32, [10, 20, 230, 255])] {
            let pixels = color.repeat((width * height) as usize);
            let jpeg = encoder.encode_rgba(&pixels, width, height).unwrap();
            let decoded = image::load_from_memory(&jpeg).unwrap().to_rgb8();
            assert_eq!(decoded.dimensions(), (width, height));
            for (actual, expected) in decoded.get_pixel(width / 2, height / 2).0.iter().zip(color) {
                assert!((*actual as i16 - expected as i16).abs() < 10);
            }
        }
    }
}
