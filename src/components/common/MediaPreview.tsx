import { useEffect, useRef, useState } from 'react';
import { formatFrameRate } from '../../core/media_streams';
import { useSkeletonPresence } from '../../hooks/useSkeletonPresence';
import { Camera, Monitor } from 'lucide-react';

export function MediaPreview({ stream, label, busy, error, settings, sourceKey = label }: {
  stream: MediaStream | null; label: string; busy: boolean; error?: string; settings: MediaTrackSettings; sourceKey?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState<{ stream: MediaStream; sourceKey: string } | null>(null);
  const loading = !error && (busy || (!!sourceKey && !stream) ||
    (!!stream && (ready?.stream !== stream || ready.sourceKey !== sourceKey)));
  const { displaySkeleton, isFadingOut } = useSkeletonPresence(loading);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let cancelled = false;
    let frameCallback: number | undefined;
    const loaded = () => {
      if (!stream) return;
      const show = () => { if (!cancelled && element.srcObject === stream) setReady({ stream, sourceKey }); };
      if (element.requestVideoFrameCallback) frameCallback = element.requestVideoFrameCallback(show);
      else show();
    };
    element.addEventListener('loadeddata', loaded, { once: true });
    element.srcObject = stream;
    if (stream) void element.play().catch(() => {});
    return () => {
      cancelled = true;
      element.removeEventListener('loadeddata', loaded);
      if (frameCallback !== undefined) element.cancelVideoFrameCallback(frameCallback);
      element.srcObject = null;
    };
  }, [stream, sourceKey]);
  return <aside className="media-preview" aria-label="Prévia local da fonte selecionada" aria-busy={loading}>
    <div className="media-preview-stage">
      <video key={`${sourceKey}:${stream?.id || 'empty'}`} ref={video} autoPlay muted playsInline aria-label={label}
        className={stream && !loading && !error ? 'media-preview-video ready' : 'media-preview-video'} />
      {displaySkeleton && <div className={`media-preview-skeleton ${isFadingOut ? 'fade-out' : ''}`} role="status"
        aria-label="Preparando prévia" aria-hidden={isFadingOut}>
        <div className="media-preview-shimmer skeleton-shimmer" aria-hidden="true" />
        <div className="source-card-thumb-skeleton-icon" aria-hidden="true">
          {sourceKey.startsWith('camera:') ? <Camera size={28} /> : <Monitor size={28} />}
        </div>
      </div>}
      {error && <p role="alert">{error}</p>}
      {!stream && !loading && !error && <p role="status">Selecione uma fonte</p>}
    </div>
    <div className="media-preview-caption"><strong>{label || 'Prévia'}</strong>
      <span>{busy ? 'Verificando dispositivo…' : settings.width && settings.height
        ? `${settings.width} × ${settings.height}${settings.frameRate ? ` · ${formatFrameRate(settings.frameRate)} FPS` : ''}` : 'Prévia local'}</span>
    </div>
  </aside>;
}
