import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '../platform/commands.ts';
import { FileText, Pencil, Trash2 } from 'lucide-react';
import { ModalDialog } from '../components/common/ModalDialog';
import { TooltipButton } from '../components/common/TooltipButton';
import { Select } from '../components/common/Select';
import { getLanguage, localizeError, t } from '../i18n';
import { useLocale } from '../hooks/useLocale';

export interface SavedNote { id: string; name: string; content: string; updatedAt: number }
export interface NoteLibrary { directory: string; notes: SavedNote[] }
export type NoteExportFormat = 'html' | 'md' | 'txt';

interface NotepadFilesProps {
  mode: 'open' | 'save' | 'export'; initialName: string;
  onOpen: (note: SavedNote | { content: string; format: string }) => void;
  onSave: (name: string, overwrite?: SavedNote) => Promise<void>;
  onRename: (note: SavedNote) => void;
  onDelete: (id: string) => void;
  onExport: (format: NoteExportFormat) => Promise<void>;
  onClose: () => void;
}
export function NotepadFilesDialog(props: NotepadFilesProps) {
  return <DocumentFilesDialog {...props} onExport={format => props.onExport(format as NoteExportFormat)} />;
}

export function DocumentFilesDialog({ mode, initialName, onOpen, onSave, onRename, onDelete, onExport, onClose, library: documentLibrary }: {
  mode: 'open' | 'save' | 'export'; initialName: string;
  onOpen: (note: SavedNote | { content: string; format: string }) => void;
  onSave: (name: string, overwrite?: SavedNote) => Promise<void>;
  onRename: (note: SavedNote) => void;
  onDelete: (id: string) => void;
  onExport: (format: string, options: { removeMargins: boolean }) => Promise<void>;
  onClose: () => void; library?: 'whiteboard';
}) {
  useLocale();
  const copy = (key: string) => t(`${documentLibrary && ['open', 'search', 'loading', 'noMatches', 'empty', 'name', 'localCopy', 'exportHint'].includes(key) ? 'whiteboard' : 'notepad'}.${key}`);
  const [library, setLibrary] = useState<NoteLibrary | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState(initialName);
  const [format, setFormat] = useState(documentLibrary ? 'p2board' : 'md');
  const [removeMargins, setRemoveMargins] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(mode === 'open');
  const [error, setError] = useState('');
  const [action, setAction] = useState<{ kind: 'rename' | 'overwrite' | 'delete'; note: SavedNote } | null>(null);
  const [rename, setRename] = useState('');
  const [childBusy, setChildBusy] = useState(false);
  const [childError, setChildError] = useState('');
  const nameId = useId();
  const committed = useRef(false);
  const closeDialog = useRef<() => void>(() => {});
  const refresh = async () => {
    setLoading(true); setError('');
    try { setLibrary(await invoke<NoteLibrary>('list_saved_notes', documentLibrary ? { library: documentLibrary } : undefined)); }
    catch (reason) { setError(documentError(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (mode === 'open') void refresh(); }, [mode]);
  const run = async (action: () => Promise<void>, close: () => void) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); close(); }
    catch (reason) { setError(documentError(reason)); }
    finally { setBusy(false); }
  };
  const save = async (close: () => void) => {
    await run(async () => {
      const latest = await invoke<NoteLibrary>('list_saved_notes', documentLibrary ? { library: documentLibrary } : undefined);
      const existing = latest.notes.find(note => note.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (existing) { setChildError(''); setAction({ kind: 'overwrite', note: existing }); }
      else { await onSave(name.trim()); close(); }
    }, () => {});
  };
  const commitAction = async (close: () => void) => {
    if (!action || childBusy) return;
    setChildBusy(true); setChildError('');
    try {
      if (action.kind === 'rename') {
        const note = await invoke<SavedNote>('rename_library_note', { id: action.note.id, name: rename.trim(),
          expectedUpdatedAt: action.note.updatedAt, ...(documentLibrary ? { library: documentLibrary } : {}) });
        onRename(note);
        await refresh();
      } else if (action.kind === 'delete') {
        await invoke('delete_library_note', { id: action.note.id, expectedUpdatedAt: action.note.updatedAt,
          ...(documentLibrary ? { library: documentLibrary } : {}) });
        onDelete(action.note.id);
        await refresh();
      } else await onSave(name.trim(), action.note);
      committed.current = true; close();
    } catch (reason) { setChildError(documentError(reason)); }
    finally { setChildBusy(false); }
  };
  return <><ModalDialog title={copy(mode)} icon={<FileText size={20} />} busy={busy || loading || Boolean(action)}
    className="modal-lg notepad-files-dialog" onClose={onClose} footer={(close) => { closeDialog.current = close; return <>
      {mode === 'open' && <>
        <button className="btn btn-secondary" disabled={busy || loading} onClick={() => void refresh()}>{t('notepad.refresh')}</button>
        <button className="btn btn-secondary" disabled={busy || loading} onClick={() => void run(async () => {
          const file = await invoke<[string, string] | null>('open_note_file', { language: getLanguage(), ...(documentLibrary ? { library: documentLibrary } : {}) });
          if (file) onOpen({ content: file[0], format: file[1] });
        }, close)}>{t('notepad.import')}</button>
      </>}
      <button className="btn btn-secondary" disabled={busy || loading} onClick={close}>{t('message.bb9dbb406dcb')}</button>
      {mode !== 'open' && <button className="btn btn-primary" disabled={busy || (mode === 'save' && !name.trim())}
        onClick={() => void (mode === 'save' ? save(close) : run(() => onExport(format, { removeMargins }), close))}>{copy(mode)}</button>}
    </>; }}>
    {mode === 'open' ? <>
      <input className="text-input" autoComplete="off" data-autofocus aria-label={copy('search')} placeholder={copy('search')}
        value={query} onChange={(event) => setQuery(event.target.value)} />
      {library && <p className="notepad-files-hint">{library.directory}</p>}
      {loading ? <p role="status">{copy('loading')}</p> : <div className="notepad-files-list">
        {library?.notes.filter((note) => note.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((note) =>
          <div className="notepad-files-row" key={note.id}>
            <div className="notepad-files-info"><strong>{note.name}</strong><span>{new Date(note.updatedAt).toLocaleString(getLanguage())}</span></div>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={t('documents.rename')} disabled={busy}
              onClick={() => { setRename(note.name); setChildError(''); setAction({ kind: 'rename', note }); }}><Pencil size={14} /></TooltipButton>
            <TooltipButton className="btn btn-sm btn-outline" tooltip={t('documents.delete')} disabled={busy}
              onClick={() => { setChildError(''); setAction({ kind: 'delete', note }); }}><Trash2 size={14} /></TooltipButton>
            <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void run(async () => {
              onOpen(await invoke<SavedNote>('read_saved_note', { id: note.id, ...(documentLibrary ? { library: documentLibrary } : {}) }));
            }, () => closeDialog.current())}>{t('message.a01a5fce396e')}</button>
          </div>)}
        {library && !library.notes.some((note) => note.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
          <p className="notepad-files-hint">{copy(query ? 'noMatches' : 'empty')}</p>}
      </div>}
    </> : mode === 'save' ? <>
      <label className="form-label" htmlFor={nameId}>{copy('name')}</label>
      <input id={nameId} className="text-input" data-autofocus autoComplete="off" maxLength={80} value={name}
        onChange={(event) => setName(event.target.value)} />
      <p className="notepad-files-hint">{copy('localCopy')}</p>
    </> : <>
      <Select aria-label={t('notepad.format')} value={format} onValueChange={(value) => setFormat(String(value))}
        options={documentLibrary ? [{ value: 'p2board', label: t('whiteboard.editable') }, { value: 'svg', label: 'SVG (.svg)' }, { value: 'png', label: 'PNG (.png)' }] : [{ value: 'md', label: 'Markdown (.md)' }, { value: 'txt', label: t('notepad.plainText') }, { value: 'html', label: t('notepad.richText') }]} />
      <p className="notepad-files-hint">{documentLibrary ? t(`whiteboard.exportHint.${format}`) : copy('exportHint')}</p>
      {documentLibrary === 'whiteboard' && format === 'png' && <label className="settings-switch-row">
        <span className="settings-switch-title">{t('whiteboard.removeMargins')}</span>
        <span className="modern-switch">
          <input autoComplete="off" type="checkbox" disabled={busy} checked={removeMargins}
            onChange={event => setRemoveMargins(event.target.checked)} />
          <span className="switch-slider" />
        </span>
      </label>}
    </>}
    {error && <p className="notepad-files-error" role="alert">{error}</p>}
  </ModalDialog>
    {action && <ModalDialog title={t(action.kind === 'rename' ? 'documents.rename' : action.kind === 'delete' ? 'documents.delete' : 'documents.overwriteTitle')}
      busy={childBusy} onClose={() => { const overwritten = action.kind === 'overwrite' && !childError && committed.current;
        committed.current = false; setAction(null); if (overwritten) closeDialog.current(); }}
      footer={close => <>
        <button className="btn btn-secondary" data-autofocus={action.kind !== 'rename' || undefined} disabled={childBusy} onClick={close}>
          {t(action.kind === 'overwrite' ? 'documents.chooseName' : 'message.bb9dbb406dcb')}</button>
        <button className={`btn ${action.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`} disabled={childBusy || (action.kind === 'rename' && !rename.trim())}
          onClick={() => void commitAction(close)}>{t(action.kind === 'rename' ? 'documents.rename' : action.kind === 'delete' ? 'documents.delete' : 'message.a5e42188d44b')}</button>
      </>}>
      {action.kind === 'rename' ? <><label className="form-label" htmlFor={`${nameId}-rename`}>{copy('name')}</label>
        <input id={`${nameId}-rename`} className="text-input" data-autofocus autoComplete="off" maxLength={80} value={rename}
          onChange={event => setRename(event.target.value)} /></> : <p>{t(action.kind === 'delete' ? 'documents.deleteHint' : 'documents.overwriteHint', { name: action.note.name })}</p>}
      {childError && <p className="notepad-files-error" role="alert">{childError}</p>}
    </ModalDialog>}
  </>;
}

function documentError(reason: unknown): string {
  return String(reason).includes('documents.nameExists') ? t('documents.nameExists') : localizeError(reason);
}
