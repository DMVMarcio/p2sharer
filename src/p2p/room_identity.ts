const ADJECTIVES = [
  'cyber',
  'neon',
  'rapid',
  'swift',
  'cosmic',
  'hyper',
  'solar',
  'lunar',
  'mystic',
  'sonic',
  'ultra',
  'mega',
  'royal',
  'epic',
  'prime',
  'iron',
  'silver',
  'golden',
  'shadow',
  'crystal',
  'astro',
  'blaze',
  'storm',
  'vortex',
  'quantum',
  'echo',
  'alpha',
  'nova',
  'turbo',
  'ninja',
  'pixel',
  'phantom',
];

const NOUNS = [
  'falcon',
  'tiger',
  'wolf',
  'eagle',
  'hawk',
  'panther',
  'fox',
  'dragon',
  'phoenix',
  'bear',
  'shark',
  'cobra',
  'viper',
  'lion',
  'lynx',
  'titan',
  'nomad',
  'runner',
  'driver',
  'spark',
  'storm',
  'pulse',
  'byte',
  'core',
  'matrix',
  'drift',
  'horizon',
  'forge',
  'nexus',
  'rover',
  'shield',
  'vortex',
];

export function generateRandomRoomSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${num}`;
}

export async function computeSignalingRoomId(roomId: string, password = ''): Promise<string> {
  const cleanRoom = roomId.trim().toLowerCase();
  const cleanPass = password.trim();
  if (!cleanPass) {
    return `public-${cleanRoom}`;
  }
  const data = new TextEncoder().encode(`p2sharer-auth:${cleanRoom}:${cleanPass}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);
  return `sec-${cleanRoom}-${hashHex}`;
}

export function generateUserColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 45%)`;
}
