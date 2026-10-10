# Profile Images

`core/profile_image.ts` owns the saved local profile, process-only remote hash cache,
peer-to-hash associations and reactive subscriptions. Card background mode is
saved as nullable `cardColor` (automatic by default); native `dominantColor` caches
an alpha-weighted palette from the visible circle of the first cropped frame.
Hue families aggregate nearby colors; meaningful chromatic regions outrank
neutral pixels and warm beige/brown tones. Earth-tone priority applies across
brightness levels, with a gradual saturation ramp that preserves vivid warm
accents; this is a color heuristic, not a skin or ethnicity classifier. A minimum visible-area threshold
rejects tiny accents, with quantized population fallback for neutral images.
Existing profiles are re-evaluated on load and Save without changing image hashes.
Automatic mode
preserves the extracted hue with moderate saturation and brightness caps, then
reduces brightness only as needed for white text contrast through
`core/profile_card_color.ts`. It also softens the initial
color without a visible image; manual colors are used verbatim. The card preset
palette is independent of the interface accent palette. Old profiles are upgraded
on load; custom and dominant colors are validated hex values. Resolved card color
travels as optional offer metadata, independent of hash-based image transfers.
`ColorPalette` shares preset swatches and the HSV picker between appearance and
profile card colors. `ParticipantCard` derives readable text from its background
through the shared contrast helper. `ProfileAvatar` renders the
same circular image/initial and contrast-aware fallback color across participants,
the header, watchers and activity participants. Profile settings retain image,
crop, removal and fallback-color drafts until Save. The crop stage supports
wheel zoom, pointer dragging and keyboard zoom/panning. An extended preview
viewport shows source overflow; image geometry and drag scale remain anchored to
the centered square crop frame. `ColorPicker` shares an HSV
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
size, fallback color and resolved card color. A cache miss creates a targeted
request with a random,
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

## Profile banners

`profileBanners` is an independent instance of the shared image store. The native
image commands accept an optional `banner` flag and use `profile-banner.json`
instead of the avatar file. The same bounded decoders, orientation handling,
metadata stripping, high-compression PNG/APNG encoder and hash validation apply.
Banner crops have a fixed 3:1 profile aspect, capped at 960 by 320 without upscaling;
the card aspect never changes the stored crop. `ProfileCropDialog` and
`core/profile_crop.ts` share preview, zoom and pan geometry between both assets.
Four native source tokens allow replacement drafts for both images; settings
retains applied sources until close so failed saves can be retried.

`profile_banner_v1` uses `ProfileTransfer` with the banner store, preserving the
same direct-peer admission, request-token, chunk, cache and native validation
boundaries. Its independent hash namespace also carries boolean `bannerEnabled`
and `bannerBlur` preferences. Card display defaults to enabled and blurred when
an image is present. Disabling card display retains the image for future profile
surfaces and reveals the unchanged avatar-derived or custom card color.
`ParticipantCard` renders a decorative cover layer with optional blur and a dark
scrim for readable foreground text. Settings owns banner upload, removal and
display-option drafts. `ProfileModal` displays the full banner regardless of its
card visibility/blur settings and uses the shared nickname and avatar components.

## Profile statistics and viewing

`core/profile_stats.ts` stores versioned aggregate totals in the main WebView local
storage. RoomService starts/stops admitted room sessions (including solo sessions),
counts successfully published new messages, and counts acknowledged complete file
transfers once per request, excluding image previews and local copies of cached
images. Call time uses a monotonic
clock, checkpoints every 15 seconds and flushes on departure/beforeunload; an abrupt
process termination can lose the final checkpoint interval. Calls, longest call,
messages, sent/received files and byte totals accumulate on this device from the
feature's introduction; history replay and message edits do not increase totals.

`profile_stats_v1` shares only bounded aggregate counters on direct admitted edges
through the room action guard, with coalesced updates and admission announcements.
Remote totals are self-reported, remain in process memory, and disappear on room
exit. They never overwrite local storage or trigger announcement loops. The shared
`profile_actions.tsx` action opens `ProfileModal` through ModalManager with the
owner identity, including media slots, chat identity context menus, participant
lists and the local header. Unknown/older clients display an unavailable state.
