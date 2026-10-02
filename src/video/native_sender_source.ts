/** Local track identity is the only way a room can authorize native capture publication. */
export interface NativeSenderSource { sessionId: string; feedbackToken: string }
const sources = new WeakMap<MediaStreamTrack, NativeSenderSource>();
export function registerNativeSenderSource(track: MediaStreamTrack, source: NativeSenderSource): void {
  sources.set(track, source);
}
export function nativeSenderSource(track?: MediaStreamTrack): NativeSenderSource | undefined {
  return track?.readyState === 'live' ? sources.get(track) : undefined;
}
