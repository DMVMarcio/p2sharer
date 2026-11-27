import { Square } from 'lucide-react';

interface Props { pending: boolean; progress: number; label: string; onCancel: () => void }

export function FileProgressRing({ pending, progress, label, onCancel }: Props) {
  const circumference = 2 * Math.PI * 13;
  const fraction = Math.min(1, Math.max(0, progress));
  return <button type="button" className={`chat-file-progress-button ${pending ? 'is-pending' : ''}`}
    aria-label={label} onClick={onCancel}>
    <svg className="chat-file-progress-outline" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <circle className="chat-file-progress-track" cx="16" cy="16" r="13" />
      {!pending && <circle className="chat-file-progress-fill" cx="16" cy="16" r="13"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fraction)} />}
    </svg>
    <Square className="chat-file-progress-stop" size={11} fill="currentColor" aria-hidden="true" />
  </button>;
}
