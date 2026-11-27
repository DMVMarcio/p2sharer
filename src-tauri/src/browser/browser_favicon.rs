//! Share a small PNG from the host profile, without making viewers fetch page URLs.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use webview2_com::{GetFaviconCompletedHandler, Microsoft::Web::WebView2::Win32::{ICoreWebView2_15, COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG}};
use windows_capture_api::core::Interface;

pub async fn read(view: &WebviewWindow) -> Result<String, String> {
    on_view(view, |core, tx| unsafe {
        let tx = Arc::new(Mutex::new(Some(tx)));
        let done = tx.clone();
        let callback = GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
            let icon = result.map_err(|e| e.to_string()).and_then(|_| {
                let Some(stream) = stream else { return Ok(String::new()); };
                let mut bytes = vec![0u8; 65537]; let mut count = 0;
                stream.Read(bytes.as_mut_ptr().cast(), bytes.len() as u32, Some(&mut count)).ok().map_err(|e| e.to_string())?;
                if count == 0 { return Ok(String::new()); }
                if count > 65536 { return Err("Browser favicon too large".into()); }
                bytes.truncate(count as usize);
                let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
                let mut limits = image::Limits::default(); limits.max_image_width = Some(512); limits.max_image_height = Some(512);
                reader.limits(limits);
                let image = image::DynamicImage::ImageRgba8(reader.decode().map_err(|e| e.to_string())?.thumbnail(32, 32).to_rgba8());
                let mut png = std::io::Cursor::new(Vec::new());
                image.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
                Ok(format!("data:image/png;base64,{}", STANDARD.encode(png.into_inner())))
            });
            if let Some(tx) = done.lock().unwrap().take() { let _ = tx.send(icon); }
            Ok(())
        }));
        let result = core.cast::<ICoreWebView2_15>().and_then(|icons| icons.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &callback));
        if let Err(e) = result { if let Some(tx) = tx.lock().unwrap().take() { let _ = tx.send(Err(e.to_string())); } }
    }).await
}
