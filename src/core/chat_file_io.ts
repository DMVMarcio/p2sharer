import { invoke } from '@tauri-apps/api/core';

/** Keep file data binary across the WebView/native boundary. */
export async function readChatFileBytes(id: string, offset: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('read_chat_file_bytes', { id, offset, length }));
}

export function writeChatDownloadBytes(id: string, offset: number, bytes: Uint8Array): Promise<number> {
  return invoke<number>('write_chat_download_bytes', bytes, {
    headers: { 'x-chat-download-id': id, 'x-chat-offset': String(offset) },
  });
}
