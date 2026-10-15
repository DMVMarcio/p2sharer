import { useDropdownPresence } from '../../hooks/useDropdownPresence';

export function MediaLoadingOverlay({ visible, label }: { visible: boolean; label: string }) {
  const presence = useDropdownPresence(visible ? label : null);
  if (!presence.value) return null;
  return <div className={`media-loading-overlay${presence.closing ? ' closing' : ''}`} inert={presence.closing} aria-hidden={presence.closing}
    role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" /><span>{presence.value}</span></div>;
}
