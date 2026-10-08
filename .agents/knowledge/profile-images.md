# Profile Images

`core/profile_image.ts` owns the saved local profile, process-only remote hash cache,
peer-to-hash associations and reactive subscriptions. `ProfileAvatar` renders the
same circular image/initial and contrast-aware fallback color across participants,
the header, watchers and activity participants. Profile settings retain image,
crop, removal and fallback-color drafts until Save. The crop stage supports
wheel zoom, pointer dragging and keyboard zoom/panning. `ColorPicker` shares an HSV
saturation/brightness plane, hue slider, keyboard-accessible channel sliders and
hex input; conversion functions live in `core/hsv_color.ts`.

`src-tauri/src/profile_image.rs` uses the native file picker and keeps original
image bytes behind temporary random tokens. The frontend receives a bounded,
data URL containing the original validated raster bytes, preserving animation and
using the detected MIME type rather than the file extension or an arbitrary path.
Selection validates all frames without resizing or re-encoding; transformations
run only on Save. Native decoders accept PNG/APNG, JPEG, GIF and WebP by their
contents, apply JPEG orientation, validate all frames,
crop to a square, cap output at 512 pixels without upscaling, and encode PNG/APNG
without imported metadata. Animation frames, transparency, loop count and bounded
frame delays survive this normalization. Original files are never overwritten.
The processed image, SHA-256 and fallback color persist together in
`profile-image.json` in the application data directory using replacement writes.

Safety bounds are 32 MiB input, 8192 pixels per axis, 16 million pixels per source
frame, 512 animation frames, 128 million cumulative decoded pixels, 128 MiB of
retained frame buffers and 8 MiB encoded output. Decoding jobs are serialized.
Oversized or malformed animations fail explicitly instead of being flattened.
Selected originals are released on cancellation, replacement or settings close.

`p2p/profile_transfer.ts` handles `profile_image_v1` on admitted, verified direct
edges through the existing room action guard. Offers contain only hash, encoded
size and fallback color. A cache miss creates a targeted request with a random,
expiring token. Only matching, ordered 32 KiB Base64 chunks within the announced
size are retained. At most four transfers are pending; other offers wait, and
duplicate hashes share cached data. Rapid offers coalesce, failed requests have
bounded retries, and disconnected peers lose pending transfers. The receiver
checks SHA-256, square PNG/APNG dimensions and complete native decoding before
display. The 64 MiB remote data URL cache has no disk persistence and dies with
the application process. Room departure clears associations and transfer state.

Save broadcasts updated metadata to existing members; admission announces it to
new members. Photo changes do not restart media or synchronize chat history.
Automatic regressions cover crop/save/cancel behavior, consent and hash reuse,
queue bounds, malformed data and GIF/APNG/animated WebP normalization. Live
two-process desktop interoperability is a separate runtime check.
