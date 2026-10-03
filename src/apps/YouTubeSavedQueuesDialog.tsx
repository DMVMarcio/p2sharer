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
          setError('Esta fila mudou. Cancele e abra a importação novamente.'); return;
        }
        onImport(action.queue.entries, mode!);
      } else if (action.kind === 'delete') {
        savedYouTubeQueues.remove(action.queue.id);
        showToast('Fila excluída.');
      } else if (action.kind === 'rename') {
        savedYouTubeQueues.rename(action.queue.id, name);
        showToast('Fila renomeada.');
      } else if (action.kind === 'overwrite') {
        savedYouTubeQueues.save(action.queue.name, action.entries, action.queue.id);
        showToast('Fila salva por cima da anterior.');
      }
      committed.current = true;
      close();
    } catch (reason) {
      console.warn('[YouTube] Saved queue action failed:', reason);
      setError(action.kind === 'import' ? 'Não foi possível importar. A fila aceita até 200 vídeos.'
        : 'Não foi possível salvar a alteração. Confira o nome, evite nomes repetidos e tente novamente.');
    }
  };
  const title = action.kind === 'import' ? 'Importar fila' : action.kind === 'delete' ? 'Excluir fila?'
    : action.kind === 'rename' ? 'Renomear fila' : 'Salvar por cima?';
  const exceedsLimit = currentCount + action.queue.entries.length > 200;
  return <ModalDialog title={title} icon={action.kind === 'delete' ? <Trash2 size={20} /> : <Library size={20} />}
    onClose={onClose} className="youtube-saved-action-dialog" footer={(close) => <>
      <button type="button" className="btn btn-secondary" data-autofocus={action.kind !== 'rename' ? true : undefined} onClick={close}>Cancelar</button>
      {action.kind === 'import' ? <>
        <button type="button" className="btn btn-secondary" disabled={exceedsLimit} onClick={() => run(close, 'append')}>Adicionar à fila</button>
        <button type="button" className="btn btn-primary" onClick={() => run(close, 'replace')}>Substituir completamente</button>
      </> : <button type="button" className={`btn ${action.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`}
        disabled={action.kind === 'rename' && !name.trim()} onClick={() => run(close)}>
        {action.kind === 'delete' ? 'Excluir' : action.kind === 'rename' ? 'Salvar nome' : 'Salvar por cima'}
      </button>}
    </>}>
    {action.kind === 'rename' ? <div className="form-group"><label className="form-label" htmlFor={inputId}>Nome da fila</label>
      <input autoComplete="off" className="text-input" id={inputId} data-autofocus maxLength={80} value={name}
        onChange={(event) => { setName(event.target.value); setError(''); }} /></div>
      : <p className="youtube-saved-action-copy">{action.kind === 'delete'
        ? <>Excluir “<strong>{action.queue.name}</strong>” das filas salvas? A fila em reprodução não será alterada.</>
        : action.kind === 'overwrite'
          ? <>Substituir os {action.queue.entries.length} vídeos salvos em “<strong>{action.queue.name}</strong>” pelos {action.entries.length} vídeos da fila atual?</>
          : <>Como deseja importar os {action.queue.entries.length} vídeos de “<strong>{action.queue.name}</strong>” para o app?</>}</p>}
    {action.kind === 'import' && <p className="youtube-saved-hint">Substituir inicia o primeiro vídeo. Adicionar mantém a reprodução atual e coloca os vídeos no final.</p>}
    {action.kind === 'import' && exceedsLimit && <p className="youtube-saved-error" role="status">Adicionar ultrapassaria o limite de 200 vídeos. Você ainda pode substituir a fila.</p>}
    {error && <p className="youtube-saved-error" role="alert">{error}</p>}
  </ModalDialog>;
}

export function YouTubeSavedQueuesDialog({ entries, onImport, onClose }: Props) {
  const [queues, setQueues] = useState<SavedYouTubeQueue[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const inputId = useId();
  useEffect(() => {
    const refresh = () => {
      try { setQueues(savedYouTubeQueues.list()); setLoadFailed(false); }
      catch { setLoadFailed(true); setError('Não foi possível ler as filas salvas neste dispositivo.'); }
    };
    refresh();
    return savedYouTubeQueues.subscribe(refresh);
  }, []);
  const existing = queues.find((queue) => savedQueueNameKey(queue.name) === savedQueueNameKey(name));
  const save = () => {
    if (!entries.length || !name.trim() || loadFailed) return;
    setError('');
    if (existing) { setAction({ kind: 'overwrite', queue: existing, entries: entries.map((entry) => ({ ...entry })) }); return; }
    try { savedYouTubeQueues.save(name, entries); setName(''); showToast('Fila salva neste dispositivo.'); }
    catch (reason) { console.warn('[YouTube] Could not save queue:', reason); setError('Não foi possível salvar. Verifique o nome e o espaço disponível; o limite é de 100 filas.'); }
  };
  return <>
    <ModalDialog title="Filas salvas" subtitle="Suas filas ficam salvas neste dispositivo." icon={<Library size={20} />}
      onClose={onClose} busy={Boolean(action)} className="modal-lg youtube-saved-queues-dialog"
      footer={(close) => <button type="button" className="btn btn-secondary" disabled={Boolean(action)} onClick={close}>Fechar</button>}>
      <form autoComplete="off" className="youtube-save-queue-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <label className="form-label" htmlFor={inputId}>Salvar fila atual · {entries.length} vídeos</label>
        <div className="youtube-save-queue-input">
          <input autoComplete="off" className="text-input" id={inputId} data-autofocus maxLength={80} placeholder="Nome da fila" value={name}
            onChange={(event) => { setName(event.target.value); if (!loadFailed) setError(''); }} />
          <button type="submit" className="btn btn-primary" disabled={!entries.length || !name.trim() || loadFailed}>
            <Save size={15} />{existing ? 'Salvar por cima' : 'Salvar'}
          </button>
        </div>
        {!entries.length && <p className="youtube-saved-hint">Adicione vídeos à fila para salvá-la.</p>}
        {existing && <p className="youtube-saved-hint">Já existe uma fila com esse nome. Você poderá confirmar a substituição.</p>}
      </form>
      {error && <p className="youtube-saved-error" role="alert">{error}</p>}
      <div className="youtube-saved-queue-list" aria-label="Filas salvas neste dispositivo">
        {!queues.length && !loadFailed && <p className="youtube-saved-empty">Nenhuma fila salva ainda.</p>}
        {queues.map((queue) => <div key={queue.id} className="youtube-saved-queue-row">
          <div className="youtube-saved-queue-info"><strong>{queue.name}</strong><span>{queue.entries.length} vídeos</span></div>
          <div className="youtube-saved-queue-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAction({ kind: 'import', queue })}><Download size={14} />Importar</button>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={`Renomear ${queue.name}`} onClick={() => setAction({ kind: 'rename', queue })}><Pencil size={15} /></TooltipButton>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={`Salvar fila atual por cima de ${queue.name}`} disabled={!entries.length}
              onClick={() => setAction({ kind: 'overwrite', queue, entries: entries.map((entry) => ({ ...entry })) })}><Save size={15} /></TooltipButton>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={`Excluir ${queue.name}`} onClick={() => setAction({ kind: 'delete', queue })}><Trash2 size={15} /></TooltipButton>
          </div>
        </div>)}
      </div>
    </ModalDialog>
    {action && <QueueActionDialog action={action} currentCount={entries.length} onImport={onImport} onClose={() => setAction(null)} />}
  </>;
}
