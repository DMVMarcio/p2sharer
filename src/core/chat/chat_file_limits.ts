// Keep each signed data-channel message below 16 KiB, including its bounded header.
export const CHAT_FILE_CHUNK_BYTES = 15 * 1024;
// Amortize native IPC and file opens without increasing SCTP message sizes.
// Must stay below the native chat_files.rs 256 KiB command limit.
export const CHAT_FILE_IO_BATCH_BYTES = 16 * CHAT_FILE_CHUNK_BYTES;
export const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;
export const CHAT_FILE_IN_FLIGHT_CHUNKS = 192;
