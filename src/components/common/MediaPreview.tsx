import { useEffect, useRef } from 'react';

export function MediaPreview({ stream, label, busy, error, settings }: {
  stream: MediaStream | null; label: string; busy: boolean; error?: string; settings: MediaTrackSettings;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => {});
    return () => { element.srcObject = null; };
  }, [stream]);
  return <aside className="media-preview" aria-label="Prévia local da fonte selecionada" aria-busy={busy}>
    <div className="media-preview-stage">
      <video ref={video} autoPlay muted playsInline aria-label={label} />
      {(!stream || error) && <p role={error ? 'alert' : 'status'}>{error || (busy ? 'Preparando prévia…' : 'Selecione uma fonte')}</p>}
    </div>
    <div className="media-preview-caption"><strong>{label || 'Prévia'}</strong>
      <span>{busy ? 'Verificando dispositivo…' : settings.width && settings.height
        ? `${settings.width} × ${settings.height}${settings.frameRate ? ` · ${Math.round(settings.frameRate * 10) / 10} FPS` : ''}` : 'Prévia local'}</span>
    </div>
  </aside>;
}
