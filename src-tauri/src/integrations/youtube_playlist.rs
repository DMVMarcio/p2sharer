use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 8_000_000;
const MAX_VIDEOS: usize = 200;

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistVideo {
    video_id: String,
    title: String,
}

fn valid_id(id: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn json_prefix(source: &str) -> Result<Value, String> {
    serde_json::Deserializer::from_str(source)
        .into_iter::<Value>()
        .next()
        .ok_or("Missing playlist data")?
        .map_err(|_| "Invalid playlist data".into())
}

// Parse data only; never execute JavaScript returned by YouTube. Initial data
// can be an object or a quoted string containing hexadecimal JS escapes.
fn script_json(source: &str) -> Result<Value, String> {
    let source = source.trim_start();
    if !source.starts_with('\'') {
        let value = json_prefix(source)?;
        return match value {
            Value::String(text) => json_prefix(&text),
            value => Ok(value),
        };
    }
    let mut quoted = String::from("\"");
    let mut chars = source[1..].chars();
    while let Some(character) = chars.next() {
        match character {
            '\'' => {
                quoted.push('"');
                let text: String =
                    serde_json::from_str(&quoted).map_err(|_| "Invalid playlist string")?;
                return json_prefix(&text);
            }
            '"' => quoted.push_str("\\\""),
            '\\' => match chars.next().ok_or("Invalid playlist escape")? {
                'x' => {
                    quoted.push_str("\\u00");
                    for _ in 0..2 {
                        let hex = chars.next().ok_or("Invalid playlist escape")?;
                        if !hex.is_ascii_hexdigit() {
                            return Err("Invalid playlist escape".into());
                        }
                        quoted.push(hex);
                    }
                }
                '\'' => quoted.push('\''),
                escape => {
                    quoted.push('\\');
                    quoted.push(escape);
                }
            },
            character => quoted.push(character),
        }
    }
    Err("Incomplete playlist string".into())
}

fn find_key<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object
            .get(key)
            .or_else(|| object.values().find_map(|item| find_key(item, key))),
        Value::Array(items) => items.iter().find_map(|item| find_key(item, key)),
        _ => None,
    }
}

fn playlist_context(html: &str) -> Option<Value> {
    html.split("ytcfg.set(")
        .skip(1)
        .find_map(|source| json_prefix(source).ok()?.get("INNERTUBE_CONTEXT").cloned())
}

fn read_items(items: &Value, videos: &mut Vec<PlaylistVideo>) -> Option<String> {
    let mut continuation = None;
    for item in items.as_array().into_iter().flatten() {
        if let Some(renderer) = item.get("playlistVideoRenderer") {
            let id = renderer["videoId"].as_str().unwrap_or("");
            if !valid_id(id, 11, 11) || renderer["isPlayable"] == false {
                continue;
            }
            let title = renderer["title"]["simpleText"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    renderer["title"]["runs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|run| run["text"].as_str())
                        .collect::<String>()
                });
            let title = title.trim();
            if !title.is_empty() && videos.len() < MAX_VIDEOS {
                videos.push(PlaylistVideo {
                    video_id: id.into(),
                    title: title.chars().take(300).collect(),
                });
            }
        }
        if let Some(token) = item
            .get("continuationItemRenderer")
            .and_then(|renderer| find_key(renderer, "continuationCommand"))
            .and_then(|command| command["token"].as_str())
        {
            continuation = Some(token.to_owned());
        }
    }
    continuation
}

async fn response_text(mut response: reqwest::Response) -> Result<String, String> {
    if !response.status().is_success() {
        return Err("YouTube playlist request failed".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Failed to read YouTube playlist")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Playlist response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Invalid playlist encoding".into())
}

#[tauri::command]
pub async fn load_youtube_playlist(playlist_id: String) -> Result<Vec<PlaylistVideo>, String> {
    if !valid_id(&playlist_id, 10, 60) || playlist_id.starts_with("RD") {
        return Err("Invalid playlist ID".into());
    }
    // Fixed endpoints and ID-only input keep this command scoped to public
    // YouTube playlists. No browser cookies or account credentials are used.
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36")
        .build().map_err(|_| "Failed to initialize playlist client")?;
    let response = client
        .get(format!(
            "https://www.youtube.com/playlist?list={playlist_id}&hl=en"
        ))
        .send()
        .await
        .map_err(|_| "Failed to request YouTube playlist")?;
    let html = response_text(response).await?;
    let initial = html
        .split_once("var ytInitialData = ")
        .ok_or("YouTube playlist data is unavailable")?
        .1;
    let data = script_json(initial)?;
    let list =
        find_key(&data, "playlistVideoListRenderer").ok_or("Playlist videos are unavailable")?;
    let mut videos = Vec::new();
    let mut continuation = read_items(&list["contents"], &mut videos);
    let context = playlist_context(&html);
    let mut seen = HashSet::new();
    for _ in 0..20 {
        let Some(token) = continuation.take() else {
            break;
        };
        if videos.len() >= MAX_VIDEOS {
            break;
        }
        if !seen.insert(token.clone()) {
            return Err("Playlist pagination did not advance".into());
        }
        let context = context
            .as_ref()
            .ok_or("Playlist continuation context is unavailable")?;
        let response = client
            .post("https://www.youtube.com/youtubei/v1/browse")
            .header("Origin", "https://www.youtube.com")
            .json(&serde_json::json!({ "context": context, "continuation": token }))
            .send()
            .await
            .map_err(|_| "Failed to request playlist continuation")?;
        let page: Value = serde_json::from_str(&response_text(response).await?)
            .map_err(|_| "Invalid playlist continuation")?;
        let action = find_key(&page, "appendContinuationItemsAction")
            .or_else(|| find_key(&page, "reloadContinuationItemsCommand"))
            .ok_or("Playlist continuation is unavailable")?;
        continuation = read_items(&action["continuationItems"], &mut videos);
    }
    if continuation.is_some() && videos.len() < MAX_VIDEOS {
        return Err("Playlist pagination limit reached".into());
    }
    if videos.is_empty() {
        return Err("Playlist contains no accessible videos".into());
    }
    Ok(videos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_context_after_early_configuration_without_browse_settings() {
        let html = r#"ytcfg.set({"BOOTSTRAP":true}); ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB"}}});"#;
        assert_eq!(
            playlist_context(html).unwrap()["client"]["clientName"],
            "WEB"
        );
    }

    #[test]
    fn reads_literal_and_hex_escaped_initial_data_without_execution() {
        assert_eq!(
            script_json(r#"{"contents":[]} ; malicious()"#).unwrap(),
            serde_json::json!({"contents": []})
        );
        assert_eq!(
            script_json(r#"'\x7b\x22contents\x22:[]\x7d'; malicious()"#).unwrap(),
            serde_json::json!({"contents": []})
        );
        assert!(script_json("'\\xGG'").is_err());
    }

    #[test]
    fn collects_ordered_entries_preserving_duplicates_and_skipping_unavailable_videos() {
        let items = serde_json::json!([
            {"playlistVideoRenderer": {"videoId": "r9F2FrmnUdk", "title": {"runs": [{"text": "First"}]}}},
            {"playlistVideoRenderer": {"videoId": "r9F2FrmnUdk", "title": {"simpleText": "Again"}}},
            {"playlistVideoRenderer": {"videoId": "bD6ifecX6rs", "isPlayable": false, "title": {"simpleText": "Private"}}},
            {"continuationItemRenderer": {"continuationEndpoint": {"commandExecutorCommand": {
                "commands": [{"unrelated": {}}, {"continuationCommand": {"token": "next"}}]
            }}}}
        ]);
        let mut videos = Vec::new();
        assert_eq!(read_items(&items, &mut videos), Some("next".into()));
        assert_eq!(videos.len(), 2);
        assert_eq!(videos[1].title, "Again");
    }

    #[tokio::test]
    #[ignore = "Requires public YouTube network access"]
    async fn imports_reported_139_video_playlist() {
        let videos = load_youtube_playlist("PL6aMbZ8nbxi5QacGkSzerXroSqxanMTVb".into())
            .await
            .unwrap();
        // YouTube's advertised total may include hidden/deleted videos.
        assert!(videos.len() > 100 && videos.len() <= 139);
        println!(
            "Imported {} accessible videos from the reported playlist",
            videos.len()
        );
    }
}
