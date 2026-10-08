use base64::{engine::general_purpose::STANDARD, Engine};
use image::{AnimationDecoder, ImageDecoder, ImageFormat, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    sync::Mutex,
};
use tauri::Manager;

const INPUT_LIMIT: usize = 32 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const PIXEL_BUDGET: u64 = 128 * 1024 * 1024;
// Serialize decoding to bound peak memory even when several peers update at once.
static IMAGE_WORK: Mutex<()> = Mutex::new(());

#[derive(Default)]
pub struct ProfileImageState(Mutex<HashMap<String, Vec<u8>>>);

#[derive(Serialize, Deserialize, Clone)]
pub struct ProfileImage {
    pub hash: String,
    pub data: String,
    pub color: String,
}

#[derive(Serialize)]
pub struct ProfileImageDraft {
    token: String,
    preview: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize, Clone, Copy)]
pub struct Crop {
    x: f64,
    y: f64,
    size: f64,
}

fn limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits
}

fn inspect(bytes: &[u8]) -> Result<(ImageFormat, u32, u32), String> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err("Image exceeds the 32 MB limit".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Invalid image")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err("Unsupported image format".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits());
    let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
    if w == 0 || h == 0 || w > 8192 || h > 8192 || u64::from(w) * u64::from(h) > 16 * 1024 * 1024 {
        return Err("Image dimensions exceed safety limits".into());
    }
    Ok((format, w, h))
}

fn crop_frame(frame: RgbaImage, crop: Crop) -> RgbaImage {
    let (w, h) = frame.dimensions();
    let side = (crop.size * f64::from(w.min(h)))
        .round()
        .clamp(1.0, f64::from(w.min(h))) as u32;
    let x = (crop.x * f64::from(w - side)).round() as u32;
    let y = (crop.y * f64::from(h - side)).round() as u32;
    let square = image::imageops::crop_imm(&frame, x, y, side, side).to_image();
    if side > 512 {
        image::imageops::resize(&square, 512, 512, image::imageops::FilterType::Lanczos3)
    } else {
        square
    }
}

fn decode(
    bytes: &[u8],
    crop: Option<Crop>,
) -> Result<(Vec<(RgbaImage, image::Delay)>, u32), String> {
    let (format, w, h) = inspect(bytes)?;
    let cursor = Cursor::new(bytes);
    let mut animation = None;
    let mut plays = 1;
    match format {
        ImageFormat::Gif => {
            let mut decoder =
                image::codecs::gif::GifDecoder::new(cursor).map_err(|e| e.to_string())?;
            decoder.set_limits(limits()).map_err(|e| e.to_string())?;
            plays = loop_count(decoder.loop_count());
            animation = Some(decoder.into_frames());
        }
        ImageFormat::Png => {
            let mut decoder =
                image::codecs::png::PngDecoder::new(cursor).map_err(|e| e.to_string())?;
            decoder.set_limits(limits()).map_err(|e| e.to_string())?;
            if decoder.is_apng().map_err(|e| e.to_string())? {
                let decoder = decoder.apng().map_err(|e| e.to_string())?;
                plays = loop_count(decoder.loop_count());
                animation = Some(decoder.into_frames());
            }
        }
        ImageFormat::WebP => {
            let mut decoder =
                image::codecs::webp::WebPDecoder::new(cursor).map_err(|e| e.to_string())?;
            decoder.set_limits(limits()).map_err(|e| e.to_string())?;
            if decoder.has_animation() {
                plays = loop_count(decoder.loop_count());
                animation = Some(decoder.into_frames());
            }
        }
        _ => {}
    }
    let mut frames = Vec::new();
    let mut retained = 0u64;
    if let Some(animation) = animation {
        for frame in animation {
            if frames.len() >= 512
                || (frames.len() as u64 + 1) * u64::from(w) * u64::from(h) > PIXEL_BUDGET
            {
                return Err("Animation exceeds safety limits".into());
            }
            let frame = frame.map_err(|e| e.to_string())?;
            let delay = frame.delay();
            let image = frame.into_buffer();
            let image = if let Some(crop) = crop {
                crop_frame(image, crop)
            } else {
                image
            };
            retained += image.as_raw().len() as u64;
            if retained > 128 * 1024 * 1024 {
                return Err("Animation exceeds memory limits".into());
            }
            frames.push((image, delay));
        }
    } else {
        let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
        reader.limits(limits());
        let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
        let orientation = decoder.orientation().map_err(|e| e.to_string())?;
        let mut image = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
        image.apply_orientation(orientation);
        let image = image.to_rgba8();
        let image = if let Some(crop) = crop {
            crop_frame(image, crop)
        } else {
            image
        };
        frames.push((image, image::Delay::from_numer_denom_ms(0, 1)));
    }
    if frames.is_empty() {
        return Err("Image has no frames".into());
    }
    Ok((frames, plays))
}

fn loop_count(count: image::metadata::LoopCount) -> u32 {
    match count {
        image::metadata::LoopCount::Infinite => 0,
        image::metadata::LoopCount::Finite(n) => n.get(),
    }
}

fn encode(frames: &[(RgbaImage, image::Delay)], plays: u32) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let (w, h) = frames[0].0.dimensions();
    let mut encoder = png::Encoder::new(&mut bytes, w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::High);
    if frames.len() > 1 {
        encoder
            .set_animated(frames.len() as u32, plays)
            .map_err(|e| e.to_string())?;
    }
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    for (frame, delay) in frames {
        if frames.len() > 1 {
            let (n, d) = delay.numer_denom_ms();
            let (numerator, denominator) = frame_delay(n, d);
            writer
                .set_frame_delay(numerator, denominator)
                .map_err(|e| e.to_string())?;
        }
        writer
            .write_image_data(frame.as_raw())
            .map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    if bytes.len() > OUTPUT_LIMIT {
        return Err("Processed animation exceeds the 8 MB safety limit".into());
    }
    Ok(bytes)
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn frame_delay(n: u32, d: u32) -> (u16, u16) {
    let (mut numerator, mut denominator) = (u64::from(n), u64::from(d) * 1000);
    let (mut a, mut b) = (numerator, denominator);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    numerator /= a;
    denominator /= a;
    let scale = numerator.max(denominator).div_ceil(u16::MAX as u64).max(1);
    (
        (numerator / scale).min(u16::MAX as u64) as u16,
        (denominator / scale).clamp(1, u16::MAX as u64) as u16,
    )
}

fn profile_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("profile-image.json"))
}

#[tauri::command]
pub async fn pick_profile_image(
    state: tauri::State<'_, ProfileImageState>,
) -> Result<Option<ProfileImageDraft>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Images", &["png", "apng", "jpg", "jpeg", "webp", "gif"])
            .pick_file()
        else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(INPUT_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let _guard = IMAGE_WORK.lock().map_err(|e| e.to_string())?;
        let (frames, _) = decode(&bytes, None)?;
        let (width, height) = frames[0].0.dimensions();
        let preview = image::imageops::resize(
            &frames[0].0,
            (width as f64 * (1024.0 / width.max(height) as f64).min(1.0)).round() as u32,
            (height as f64 * (1024.0 / width.max(height) as f64).min(1.0)).round() as u32,
            image::imageops::FilterType::Triangle,
        );
        let preview = encode(&[(preview, frames[0].1)], 1)?;
        Ok::<_, String>(Some((bytes, width, height, preview)))
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some((bytes, width, height, preview)) = picked else {
        return Ok(None);
    };
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let token = STANDARD.encode(nonce);
    let mut drafts = state.0.lock().map_err(|e| e.to_string())?;
    if drafts.len() >= 2 {
        return Err("Too many pending image selections".into());
    }
    drafts.insert(token.clone(), bytes);
    Ok(Some(ProfileImageDraft {
        token,
        preview: format!("data:image/png;base64,{}", STANDARD.encode(preview)),
        width,
        height,
    }))
}

#[tauri::command]
pub fn discard_profile_image(state: tauri::State<'_, ProfileImageState>, token: Option<String>) {
    if let Ok(mut drafts) = state.0.lock() {
        if let Some(token) = token {
            drafts.remove(&token);
        } else {
            drafts.clear();
        }
    }
}

#[tauri::command]
pub async fn save_profile_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProfileImageState>,
    token: Option<String>,
    crop: Option<Crop>,
    color: String,
    remove: bool,
) -> Result<ProfileImage, String> {
    if !valid_color(&color) {
        return Err("Invalid profile color".into());
    }
    let bytes = if let Some(token) = token {
        let draft = state.0.lock().map_err(|e| e.to_string())?;
        Some(draft.get(&token).ok_or("Image selection expired")?.clone())
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = IMAGE_WORK.lock().map_err(|e| e.to_string())?;
        let path = profile_path(&app)?;
        let mut profile = if path.exists() {
            serde_json::from_slice::<ProfileImage>(
                &std::fs::read(&path).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?
        } else {
            ProfileImage {
                hash: String::new(),
                data: String::new(),
                color: color.clone(),
            }
        };
        profile.color = color;
        if remove {
            profile.hash.clear();
            profile.data.clear();
        }
        if let Some(bytes) = bytes {
            let crop = crop.ok_or("Missing crop")?;
            if ![crop.x, crop.y, crop.size]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0)
                || crop.size == 0.0
            {
                return Err("Invalid crop".into());
            }
            let (frames, plays) = decode(&bytes, Some(crop))?;
            let bytes = encode(&frames, plays)?;
            profile.hash = format!("{:x}", Sha256::digest(&bytes));
            profile.data = STANDARD.encode(bytes);
        }
        // The previous profile stays intact if decoding, compression or writing fails.
        let temp = path.with_extension("tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec(&profile).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(temp, path).map_err(|e| e.to_string())?;
        Ok(profile)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn validate_profile_image(data: String, hash: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if data.len() > OUTPUT_LIMIT.div_ceil(3) * 4 {
            return Err("Profile image is too large".into());
        }
        let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
        if bytes.len() > OUTPUT_LIMIT || format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err("Profile hash mismatch".into());
        }
        let (format, w, h) = inspect(&bytes)?;
        if format != ImageFormat::Png || w != h || w > 512 {
            return Err("Invalid profile dimensions or format".into());
        }
        let _guard = IMAGE_WORK.lock().map_err(|e| e.to_string())?;
        decode(&bytes, None)?;
        Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn load_profile_image(app: tauri::AppHandle) -> Result<Option<ProfileImage>, String> {
    let path = profile_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > OUTPUT_LIMIT * 2 {
        return Err("Invalid saved profile".into());
    }
    let profile: ProfileImage = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !valid_color(&profile.color) {
        return Err("Invalid saved profile color".into());
    }
    if !profile.data.is_empty() {
        validate_profile_image(profile.data.clone(), profile.hash.clone()).await?;
    }
    Ok(Some(profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32, rgba: [u8; 4], ms: u32) -> (RgbaImage, image::Delay) {
        (
            RgbaImage::from_pixel(w, h, image::Rgba(rgba)),
            image::Delay::from_numer_denom_ms(ms, 1),
        )
    }

    #[test]
    fn crop_is_square_does_not_upscale_and_caps_large_images() {
        let small = crop_frame(
            frame(40, 20, [255, 0, 0, 255], 0).0,
            Crop {
                x: 1.0,
                y: 0.0,
                size: 1.0,
            },
        );
        assert_eq!(small.dimensions(), (20, 20));
        let large = crop_frame(
            frame(900, 600, [0, 0, 255, 255], 0).0,
            Crop {
                x: 0.5,
                y: 0.5,
                size: 1.0,
            },
        );
        assert_eq!(large.dimensions(), (512, 512));
        let mut source = RgbaImage::from_pixel(8, 4, image::Rgba([255, 0, 0, 255]));
        for x in 4..8 {
            for y in 0..4 {
                source.put_pixel(x, y, image::Rgba([0, 255, 0, 255]));
            }
        }
        let right = crop_frame(
            source,
            Crop {
                x: 1.0,
                y: 0.5,
                size: 1.0,
            },
        );
        assert!(right.pixels().all(|p| p.0 == [0, 255, 0, 255]));
    }

    #[test]
    fn apng_roundtrip_preserves_frames_alpha_delay_and_loop_count() {
        let source = vec![
            frame(8, 8, [255, 0, 0, 255], 80),
            frame(8, 8, [0, 0, 255, 64], 120),
        ];
        let bytes = encode(&source, 3).unwrap();
        let (decoded, plays) = decode(&bytes, None).unwrap();
        assert_eq!(plays, 3);
        assert_eq!(decoded.len(), 2);
        for (expected, actual) in source.iter().zip(decoded.iter()) {
            assert_eq!(expected.0, actual.0);
            assert_eq!(expected.1.numer_denom_ms(), actual.1.numer_denom_ms());
        }
    }

    #[test]
    fn animated_gif_is_cropped_and_encoded_without_flattening() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            encoder
                .set_repeat(image::codecs::gif::Repeat::Infinite)
                .unwrap();
            for color in [[255, 0, 0, 255], [0, 0, 255, 255]] {
                let (buffer, delay) = frame(12, 8, color, 100);
                encoder
                    .encode_frame(image::Frame::from_parts(buffer, 0, 0, delay))
                    .unwrap();
            }
        }
        let (frames, plays) = decode(
            &bytes,
            Some(Crop {
                x: 0.5,
                y: 0.5,
                size: 0.5,
            }),
        )
        .unwrap();
        let processed = encode(&frames, plays).unwrap();
        let (frames, plays) = decode(&processed, None).unwrap();
        assert_eq!(plays, 0);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].0.dimensions(), (4, 4));
        assert_ne!(frames[0].0, frames[1].0);
    }

    #[test]
    fn animated_webp_and_static_formats_use_the_same_safe_pipeline() {
        fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut result = tag.to_vec();
            result.extend_from_slice(&(data.len() as u32).to_le_bytes());
            result.extend_from_slice(data);
            if data.len() % 2 != 0 {
                result.push(0);
            }
            result
        }
        // Build a minimal animated RIFF container from generated lossless frames.
        // No downloaded/user media or device-dependent fixtures are involved.
        let mut contents = b"WEBP".to_vec();
        contents.extend(chunk(b"VP8X", &[2, 0, 0, 0, 3, 0, 0, 3, 0, 0]));
        contents.extend(chunk(b"ANIM", &[0, 0, 0, 0, 3, 0]));
        for color in [[255, 0, 0, 255], [0, 0, 255, 255]] {
            let mut encoded = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(frame(4, 4, color, 0).0)
                .write_to(&mut encoded, ImageFormat::WebP)
                .unwrap();
            let mut payload = vec![0, 0, 0, 0, 0, 0, 3, 0, 0, 3, 0, 0, 100, 0, 0, 2];
            payload.extend_from_slice(&encoded.into_inner()[12..]);
            contents.extend(chunk(b"ANMF", &payload));
        }
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(contents.len() as u32).to_le_bytes());
        bytes.extend(contents);
        let (frames, plays) = decode(
            &bytes,
            Some(Crop {
                x: 0.5,
                y: 0.5,
                size: 1.0,
            }),
        )
        .unwrap();
        assert_eq!(plays, 3);
        assert_eq!(frames.len(), 2);
        let (roundtrip, plays) = decode(&encode(&frames, plays).unwrap(), None).unwrap();
        assert_eq!(plays, 3);
        assert_eq!(roundtrip.len(), 2);
        assert_eq!(roundtrip[1].0, frames[1].0);
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(frame(12, 8, [255, 0, 0, 255], 0).0)
                .to_rgb8()
                .write_to(&mut bytes, format)
                .unwrap();
            let (frames, _) = decode(
                &bytes.into_inner(),
                Some(Crop {
                    x: 0.5,
                    y: 0.5,
                    size: 1.0,
                }),
            )
            .unwrap();
            assert_eq!(frames[0].0.dimensions(), (8, 8));
        }
    }

    #[tokio::test]
    async fn received_images_require_matching_hash_and_bounded_square_png() {
        let bytes = encode(&[frame(8, 8, [255, 0, 0, 255], 0)], 1).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        assert!(validate_profile_image(STANDARD.encode(&bytes), hash)
            .await
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(
            validate_profile_image(STANDARD.encode(&bytes), "0".repeat(64))
                .await
                .is_err()
        );
        let bytes = encode(&[frame(10, 8, [255, 0, 0, 255], 0)], 1).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        assert!(validate_profile_image(STANDARD.encode(bytes), hash)
            .await
            .is_err());
        assert!(decode(b"<svg onload='alert(1)'/>", None).is_err());
        let frames = vec![frame(1, 1, [0, 0, 0, 255], 10); 513];
        assert!(decode(&encode(&frames, 0).unwrap(), None).is_err());
        let mut broken = encode(&[frame(8, 8, [255, 0, 0, 255], 0)], 1).unwrap();
        broken.truncate(40);
        assert!(decode(&broken, None).is_err());
    }
}
