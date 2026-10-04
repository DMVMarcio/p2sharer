import { t } from '../i18n/index.ts';
import type { YouTubeEntry } from './types';

const VIDEO_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^[\w-]{10,60}$/;
// RD identifiers represent generated radio/Mix queues, not importable playlists.
const isImportablePlaylist = (id: string) => PLAYLIST_ID.test(id) && !id.startsWith('RD');
const INVIDIOUS_INSTANCES = [
  'https://invidious.f5.si',
  'https://invidious.tiekoetter.com',
  'https://yt.chocolatemoo53.com',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
];
const titleRequests = new Map<string, Promise<string | null>>();
export interface YouTubeSearchItem { kind: 'video' | 'playlist'; id: string; title: string;
  count?: number; thumbnailVideoId?: string }

export function resolveYouTubeTitle(videoId: string): Promise<string | null> {
  if (!VIDEO_ID.test(videoId)) return Promise.resolve(null);
  const cached = titleRequests.get(videoId);
  if (cached) return cached;
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`);
  url.searchParams.set('format', 'json');
  const request = fetch(url, { signal: AbortSignal.timeout(8000) }).then(async (response) => {
    if (!response.ok) return null;
    const data: unknown = await response.json();
    const title = (data as { title?: unknown })?.title;
    return typeof title === 'string' && title.trim() && title.length <= 300 ? title.trim() : null;
  }).catch(() => null);
  titleRequests.set(videoId, request);
  return request;
}

export function parseYouTubeInput(input: string): { videoId?: string; playlistId?: string } {
  const trimmed = input.trim();
  if (VIDEO_ID.test(trimmed)) return { videoId: trimmed };
  try {
    const url = new URL(trimmed);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
      'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'].includes(url.hostname)) return {};
    const videoId = url.hostname === 'youtu.be' ? url.pathname.slice(1) :
      /^\/(shorts|live|embed|v)\//.test(url.pathname) ? url.pathname.split('/')[2] : url.searchParams.get('v');
    const playlistId = url.searchParams.get('list') || undefined;
    return { videoId: videoId && VIDEO_ID.test(videoId) ? videoId : undefined,
      playlistId: playlistId && isImportablePlaylist(playlistId) ? playlistId : undefined };
  } catch { return {}; }
}

async function invidiousRequest(path: string, params: Record<string, string> = {},
  accept: (data: unknown) => boolean = () => true,
  failureMessage = t("message.8b92ac7ffe1f")): Promise<unknown> {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const url = new URL(`/api/v1/${path}`, instance);
      Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) continue;
      const data: unknown = await response.json();
      if (!accept(data)) continue;
      return data;
    } catch { /* Try the next documented public instance. */ }
  }
  throw new Error(failureMessage);
}

function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 300;
}

export function parseInvidiousResults(value: unknown): YouTubeSearchItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap<YouTubeSearchItem>((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const result = item as Record<string, unknown>;
    if (!validTitle(result.title)) return [];
    if (result.type === 'video' && typeof result.videoId === 'string' && VIDEO_ID.test(result.videoId))
      return [{ kind: 'video' as const, id: result.videoId, title: result.title.trim() }];
    if (result.type === 'playlist' && typeof result.playlistId === 'string' && isImportablePlaylist(result.playlistId))
      return [{ kind: 'playlist' as const, id: result.playlistId, title: result.title.trim() }];
    return [];
  }).slice(0, 20);
}

export async function searchYouTube(query: string): Promise<YouTubeSearchItem[]> {
  const data = await invidiousRequest('search', { q: query.slice(0, 120), type: 'all' });
  return parseInvidiousResults(data);
}

export async function loadYouTubePlaylistPreview(id: string): Promise<{
  title: string; count?: number; thumbnailVideoId?: string
} | null> {
  if (!isImportablePlaylist(id)) return null;
  const data = await invidiousRequest(`playlists/${id}`);
  if (!data || typeof data !== 'object') return null;
  const playlist = data as Record<string, unknown>;
  const entries = parseInvidiousPlaylist(data);
  return { title: validTitle(playlist.title) ? playlist.title.trim() : `Playlist ${id}`,
    count: typeof playlist.videoCount === 'number' && Number.isSafeInteger(playlist.videoCount) &&
      playlist.videoCount >= 0 ? playlist.videoCount : undefined,
    thumbnailVideoId: entries[0]?.videoId };
}

export function parseInvidiousPlaylist(value: unknown): YouTubeEntry[] {
  if (!value || typeof value !== 'object') return [];
  const videos = (value as { videos?: unknown }).videos;
  if (!Array.isArray(videos)) return [];
  return videos.slice(0, 200).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const video = entry as { videoId?: unknown; title?: unknown };
    return typeof video.videoId === 'string' && VIDEO_ID.test(video.videoId) && validTitle(video.title)
      ? [{ videoId: video.videoId, title: video.title.trim() }] : [];
  });
}

export async function loadYouTubePlaylist(id: string): Promise<YouTubeEntry[]> {
  if (!isImportablePlaylist(id)) return [];
  const { isTauri, invoke } = await import('@tauri-apps/api/core');
  if (isTauri()) {
    try {
      const data = await invoke<unknown>('load_youtube_playlist', { playlistId: id });
      const entries = parseInvidiousPlaylist({ videos: data });
      if (entries.length) return entries;
    } catch { /* Fall back to validated public API responses. */ }
  }
  const videos: YouTubeEntry[] = [];
  for (let page = 1; page <= 4 && videos.length < 200; page++) {
    const data = await invidiousRequest(`playlists/${id}`, { page: String(page) }, (value) => {
      if (!value || typeof value !== 'object' || !Array.isArray((value as { videos?: unknown }).videos)) return false;
      const record = value as { videoCount?: unknown; videos: unknown[]; error?: unknown };
      if (record.error) return false;
      return record.videos.length > 0 && parseInvidiousPlaylist(value).length > 0;
    }, t("message.a97b5fda5f58"));
    const entries = parseInvidiousPlaylist(data);
    videos.push(...entries.slice(0, 200 - videos.length));
    const record = data as { videoCount?: number; videos: unknown[] };
    if ((Number.isSafeInteger(record.videoCount) && videos.length >= record.videoCount!) || record.videos.length < 50) break;
  }
  if (!videos.length) throw new Error(t("message.f26f2c1bb071"));
  return videos;
}
