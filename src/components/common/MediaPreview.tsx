import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useEffect, useRef, useState } from 'react';
import { formatFrameRate } from '../../core/media_streams';
import { useSkeletonPresence } from '../../hooks/useSkeletonPresence';
import { Camera, Monitor } from 'lucide-react';

export function MediaPreview({ stream, label, busy, error, settings, sourceKey = label, onError, onRetry }: {
  stream: MediaStream | null; label: string; busy: boolean; error?: string; settings: MediaTrackSettings; sourceKey?: string;
  onError?: () => void; onRetry?: () => void;
}) {
  useLocale();
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
    if (stream && element.readyState >= 2) loaded();
    return () => {
      cancelled = true;
      element.removeEventListener('loadeddata', loaded);
      if (frameCallback !== undefined) element.cancelVideoFrameCallback(frameCallback);
      element.srcObject = null;
    };
  }, [stream, sourceKey]);
  useEffect(() => {
    if (!stream || busy || error || (ready?.stream === stream && ready.sourceKey === sourceKey)) return;
    const timer = setTimeout(() => {
      const element = video.current;
      // loadeddata already guarantees a decoded frame. Some WebView2 drivers
      // do not deliver another compositor callback until the video is visible.
      if (element?.srcObject === stream && element.readyState >= 2) setReady({ stream, sourceKey });
      else onError?.();
    }, 8000);
    return () => clearTimeout(timer);
  }, [stream, sourceKey, busy, error, ready, onError]);
  return <aside className="media-preview" aria-label={t("message.d7b064249569")} aria-busy={loading}>
    <div className="media-preview-stage">
      <video key={`${sourceKey}:${stream?.id || 'empty'}`} ref={video} autoPlay muted playsInline aria-label={label} onError={onError}
        className={stream && !loading && !error ? 'media-preview-video ready' : 'media-preview-video'} />
      {displaySkeleton && <div className={`media-preview-skeleton ${isFadingOut ? 'fade-out' : ''}`} role="status"
        aria-label={t("message.72e18f67980f")} aria-hidden={isFadingOut}>
        <div className="media-preview-shimmer skeleton-shimmer" aria-hidden="true" />
        <div className="source-card-thumb-skeleton-icon" aria-hidden="true">
          {sourceKey.startsWith('camera:') ? <Camera size={28} /> : <Monitor size={28} />}
        </div>
      </div>}
      {error && <p role="alert">{localizeText(error)}</p>}
      {!stream && !loading && !error && <p role="status">{t("message.18aeee759388")}</p>}
    </div>
    <div className="media-preview-caption"><strong>{label || t("message.7cf015b6b2cb")}</strong>
      <span>{busy ? t("message.d14a44cefc01") : settings.width && settings.height
        ? `${settings.width} × ${settings.height}${settings.frameRate ? ` · ${formatFrameRate(settings.frameRate)} FPS` : ''}` : t("message.dd6207727459")}</span>
      {error && onRetry && <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>{t('capture.retryPreview')}</button>}
    </div>
  </aside>;
}
