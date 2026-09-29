// Keep each signed data-channel message below 16 KiB, including its bounded header.
export const CHAT_FILE_CHUNK_BYTES = 15 * 1024;
export const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;
export const CHAT_FILE_IN_FLIGHT_CHUNKS = 192;
