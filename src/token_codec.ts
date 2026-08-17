import { deflate, inflate } from 'pako';
import { RoomToken } from './types';

/**
 * Compresses and encodes an SDP/Candidate token into a compact alphanumeric string
 * that is easy to copy, paste, or send via any messaging app.
 */
export function encodeToken(token: RoomToken): string {
  try {
    const jsonStr = JSON.stringify(token);
    const compressed = deflate(jsonStr, { level: 9 });
    let binary = '';
    for (let i = 0; i < compressed.length; i++) {
      binary += String.fromCharCode(compressed[i]);
    }
    const b64 = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    
    const prefix = token.type === 'offer' ? 'P2P-OFFER' : 'P2P-JOIN';
    return `${prefix}:${b64}`;
  } catch (err) {
    console.error('Failed to encode token:', err);
    throw new Error('Erro ao compactar token de conexão.');
  }
}

/**
 * Decodes and decompresses a token string into a RoomToken object.
 */
export function decodeToken(rawInput: string): RoomToken {
  try {
    const cleanStr = rawInput.trim();
    let b64 = cleanStr;

    if (cleanStr.includes(':')) {
      b64 = cleanStr.split(':')[1].trim();
    }

    // Convert from URL-safe Base64 back to standard
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) {
      b64 += '=';
    }

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const decompressedBytes = inflate(bytes);
    const decompressedJson = new TextDecoder().decode(decompressedBytes);
    const parsed = JSON.parse(decompressedJson) as RoomToken;

    if (!parsed.sdp || !parsed.type) {
      throw new Error('Formato de token inválido.');
    }

    return parsed;
  } catch (err) {
    console.error('Failed to decode token:', err);
    throw new Error('Código de convite ou resposta inválido. Verifique se copiou o código completo.');
  }
}
