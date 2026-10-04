import { localizeText, t } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import { useEffect, useId, useRef, useState } from 'react';
import { Download, Library, Pencil, Save, Trash2 } from 'lucide-react';
import { ModalDialog } from '../components/common/ModalDialog';
import { TooltipButton } from '../components/common/TooltipButton';
import { showToast } from '../hooks/useToast';
import { savedQueueNameKey, savedYouTubeQueues, type SavedYouTubeQueue } from './youtube_saved_queues';
import type { YouTubeEntry } from './types';

type Action = { kind: 'import' | 'delete' | 'rename'; queue: SavedYouTubeQueue } |
  { kind: 'overwrite'; queue: SavedYouTubeQueue; entries: YouTubeEntry[] };
interface Props {
  entries: YouTubeEntry[];
  onImport: (entries: YouTubeEntry[], mode: 'replace' | 'append') => void;
  onClose: () => void;
}

function QueueActionDialog({ action, currentCount, onImport, onClose }: {
  action: Action; currentCount: number; onImport: Props['onImport']; onClose: () => void;
}) {
  useLocale();
  const [name, setName] = useState(action.queue.name);
  const [error, setError] = useState('');
  const inputId = useId();
  const committed = useRef(false);
  const run = (close: () => void, mode?: 'replace' | 'append') => {
    if (committed.current) return;
    try {
      if (action.kind === 'import') {
        const latest = savedYouTubeQueues.list().find((queue) => queue.id === action.queue.id);
        if (!latest || latest.updatedAt !== action.queue.updatedAt) {
          setError(t("message.d5d8f9884853")); return;
        }
        onImport(action.queue.entries, mode!);
      } else if (action.kind === 'delete') {
        savedYouTubeQueues.remove(action.queue.id);
        showToast(t("message.48443a6d1ef2"));
      } else if (action.kind === 'rename') {
        savedYouTubeQueues.rename(action.queue.id, name);
        showToast(t("message.bd5d65e0df35"));
      } else if (action.kind === 'overwrite') {
        savedYouTubeQueues.save(action.queue.name, action.entries, action.queue.id);
        showToast(t("message.b47a76414d09"));
      }
      committed.current = true;
      close();
    } catch (reason) {
      console.warn('[YouTube] Saved queue action failed:', reason);
      setError(action.kind === 'import' ? t("message.92d18dc6ffd3")
        : t("message.af54dd689862"));
    }
  };
  const title = action.kind === 'import' ? t("message.803f58c7bbb8") : action.kind === 'delete' ? t("message.8bb9d415e825")
    : action.kind === 'rename' ? t("message.0698ca644666") : t("message.7ada9bad8fad");
  const exceedsLimit = currentCount + action.queue.entries.length > 200;
  return <ModalDialog title={title} icon={action.kind === 'delete' ? <Trash2 size={20} /> : <Library size={20} />}
    onClose={onClose} className="youtube-saved-action-dialog" footer={(close) => <>
      <button type="button" className="btn btn-secondary" data-autofocus={action.kind !== 'rename' ? true : undefined} onClick={close}>{t("message.bb9dbb406dcb")}</button>
      {action.kind === 'import' ? <>
        <button type="button" className="btn btn-secondary" disabled={exceedsLimit} onClick={() => run(close, 'append')}>{t("message.dccbf9e7df69")}</button>
        <button type="button" className="btn btn-primary" onClick={() => run(close, 'replace')}>{t("message.affa483c6014")}</button>
      </> : <button type="button" className={`btn ${action.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`}
        disabled={action.kind === 'rename' && !name.trim()} onClick={() => run(close)}>
        {action.kind === 'delete' ? t("message.8b19518ff49b") : action.kind === 'rename' ? t("message.79b680c319cc") : t("message.a5e42188d44b")}
      </button>}
    </>}>
    {action.kind === 'rename' ? <div className="form-group"><label className="form-label" htmlFor={inputId}>{t("message.8ca10b5dd0ea")}</label>
      <input autoComplete="off" className="text-input" id={inputId} data-autofocus maxLength={80} value={name}
        onChange={(event) => { setName(event.target.value); setError(''); }} /></div>
      : <p className="youtube-saved-action-copy">{action.kind === 'delete'
        ? <>{t("message.8cfe2155e212")}<strong>{action.queue.name}</strong>{t("message.1a86fae81fc8")}</>
        : action.kind === 'overwrite'
          ? <>{t("message.8ce9e813c81b")} {action.queue.entries.length}  {t("message.44fa609a057b")}<strong>{action.queue.name}</strong>{t("message.02e0d6a4ec6c")} {action.entries.length}  {t("message.df1e6f1b0291")}</>
          : <>{t("message.16dd9b1988ad")} {action.queue.entries.length}  {t("message.ef972ca46104")}<strong>{action.queue.name}</strong>{t("message.646d5cd80e51")}</>}</p>}
    {action.kind === 'import' && <p className="youtube-saved-hint">{t("message.7f05e09d31b6")}</p>}
    {action.kind === 'import' && exceedsLimit && <p className="youtube-saved-error" role="status">{t("message.b19cb4b24088")}</p>}
    {error && <p className="youtube-saved-error" role="alert">{localizeText(error)}</p>}
  </ModalDialog>;
}

export function YouTubeSavedQueuesDialog({ entries, onImport, onClose }: Props) {
  useLocale();
  const [queues, setQueues] = useState<SavedYouTubeQueue[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const inputId = useId();
  useEffect(() => {
    const refresh = () => {
      try { setQueues(savedYouTubeQueues.list()); setLoadFailed(false); }
      catch { setLoadFailed(true); setError(t("message.68e75df1d09c")); }
    };
    refresh();
    return savedYouTubeQueues.subscribe(refresh);
  }, []);
  const existing = queues.find((queue) => savedQueueNameKey(queue.name) === savedQueueNameKey(name));
  const save = () => {
    if (!entries.length || !name.trim() || loadFailed) return;
    setError('');
    if (existing) { setAction({ kind: 'overwrite', queue: existing, entries: entries.map((entry) => ({ ...entry })) }); return; }
    try { savedYouTubeQueues.save(name, entries); setName(''); showToast(t("message.aac0486d4806")); }
    catch (reason) { console.warn('[YouTube] Could not save queue:', reason); setError(t("message.f5475ff2e3e7")); }
  };
  return <>
    <ModalDialog title={t("message.13ebb5489523")} subtitle={t('youtube.savedLocally')} icon={<Library size={20} />}
      onClose={onClose} busy={Boolean(action)} className="modal-lg youtube-saved-queues-dialog"
      footer={(close) => <button type="button" className="btn btn-secondary" disabled={Boolean(action)} onClick={close}>{t("message.0f2bd88ef0ac")}</button>}>
      <form autoComplete="off" className="youtube-save-queue-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <label className="form-label" htmlFor={inputId}>{t("message.da5e5cf894b6")} {entries.length}  {t("message.d24e460768fa")}</label>
        <div className="youtube-save-queue-input">
          <input autoComplete="off" className="text-input" id={inputId} data-autofocus maxLength={80} placeholder={t("message.8ca10b5dd0ea")} value={name}
            onChange={(event) => { setName(event.target.value); if (!loadFailed) setError(''); }} />
          <button type="submit" className="btn btn-primary" disabled={!entries.length || !name.trim() || loadFailed}>
            <Save size={15} />{existing ? t("message.a5e42188d44b") : t("message.aef7cd5b2081")}
          </button>
        </div>
        {!entries.length && <p className="youtube-saved-hint">{t("message.bf7eb8a184cf")}</p>}
        {existing && <p className="youtube-saved-hint">{t("message.0201ee40bd8f")}</p>}
      </form>
      {error && <p className="youtube-saved-error" role="alert">{localizeText(error)}</p>}
      <div className="youtube-saved-queue-list" aria-label={t("message.64c5b46f6c38")}>
        {!queues.length && !loadFailed && <p className="youtube-saved-empty">{t("message.7b7486566406")}</p>}
        {queues.map((queue) => <div key={queue.id} className="youtube-saved-queue-row">
          <div className="youtube-saved-queue-info"><strong>{queue.name}</strong><span>{queue.entries.length}  {t("message.d24e460768fa")}</span></div>
          <div className="youtube-saved-queue-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAction({ kind: 'import', queue })}><Download size={14} />{t("message.e7f0e6d956c1")}</button>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={t("message.1683bb6fb7a3", { v0: queue.name })} onClick={() => setAction({ kind: 'rename', queue })}><Pencil size={15} /></TooltipButton>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={t("message.5dc6b4357c37", { v0: queue.name })} disabled={!entries.length}
              onClick={() => setAction({ kind: 'overwrite', queue, entries: entries.map((entry) => ({ ...entry })) })}><Save size={15} /></TooltipButton>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={t("message.0e100ffcab6e", { v0: queue.name })} onClick={() => setAction({ kind: 'delete', queue })}><Trash2 size={15} /></TooltipButton>
          </div>
        </div>)}
      </div>
    </ModalDialog>
    {action && <QueueActionDialog action={action} currentCount={entries.length} onImport={onImport} onClose={() => setAction(null)} />}
  </>;
}
