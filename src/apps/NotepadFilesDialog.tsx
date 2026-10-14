import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText } from 'lucide-react';
import { ModalDialog } from '../components/common/ModalDialog';
import { Select } from '../components/common/Select';
import { getLanguage, localizeError, t } from '../i18n';
import { useLocale } from '../hooks/useLocale';

export interface SavedNote { id: string; name: string; content: string; updatedAt: number }
export interface NoteLibrary { directory: string; notes: SavedNote[] }
export type NoteExportFormat = 'html' | 'md' | 'txt';

export function NotepadFilesDialog({ mode, initialName, onOpen, onSave, onExport, onClose }: {
  mode: 'open' | 'save' | 'export'; initialName: string;
  onOpen: (note: SavedNote | { content: string; format: string }) => void;
  onSave: (name: string) => Promise<void>;
  onExport: (format: NoteExportFormat) => Promise<void>;
  onClose: () => void;
}) {
  useLocale();
  const [library, setLibrary] = useState<NoteLibrary | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState(initialName);
  const [format, setFormat] = useState<NoteExportFormat>('md');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(mode === 'open');
  const [error, setError] = useState('');
  const nameId = useId();
  const closeDialog = useRef<() => void>(() => {});
  const refresh = async () => {
    setLoading(true); setError('');
    try { setLibrary(await invoke<NoteLibrary>('list_saved_notes')); }
    catch (reason) { setError(localizeError(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (mode === 'open') void refresh(); }, [mode]);
  const run = async (action: () => Promise<void>, close: () => void) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); close(); }
    catch (reason) { setError(localizeError(reason)); }
    finally { setBusy(false); }
  };
  return <ModalDialog title={t(`notepad.${mode}`)} icon={<FileText size={20} />} busy={busy || loading}
    className="modal-lg notepad-files-dialog" onClose={onClose} footer={(close) => { closeDialog.current = close; return <>
      {mode === 'open' && <>
        <button className="btn btn-secondary" disabled={busy || loading} onClick={() => void refresh()}>{t('notepad.refresh')}</button>
        <button className="btn btn-secondary" disabled={busy || loading} onClick={() => void run(async () => {
          const file = await invoke<[string, string] | null>('open_note_file', { language: getLanguage() });
          if (file) onOpen({ content: file[0], format: file[1] });
        }, close)}>{t('notepad.import')}</button>
      </>}
      <button className="btn btn-secondary" disabled={busy || loading} onClick={close}>{t('message.bb9dbb406dcb')}</button>
      {mode !== 'open' && <button className="btn btn-primary" disabled={busy || (mode === 'save' && !name.trim())}
        onClick={() => void run(() => mode === 'save' ? onSave(name.trim()) : onExport(format), close)}>{t(`notepad.${mode}`)}</button>}
    </>; }}>
    {mode === 'open' ? <>
      <input className="text-input" autoComplete="off" data-autofocus aria-label={t('notepad.search')} placeholder={t('notepad.search')}
        value={query} onChange={(event) => setQuery(event.target.value)} />
      {library && <p className="notepad-files-hint">{library.directory}</p>}
      {loading ? <p role="status">{t('notepad.loading')}</p> : <div className="notepad-files-list">
        {library?.notes.filter((note) => note.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((note) =>
          <div className="notepad-files-row" key={note.id}>
            <div className="notepad-files-info"><strong>{note.name}</strong><span>{new Date(note.updatedAt).toLocaleString(getLanguage())}</span></div>
            <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void run(async () => {
              onOpen(await invoke<SavedNote>('read_saved_note', { id: note.id }));
            }, () => closeDialog.current())}>{t('message.a01a5fce396e')}</button>
          </div>)}
        {library && !library.notes.some((note) => note.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
          <p className="notepad-files-hint">{t(query ? 'notepad.noMatches' : 'notepad.empty')}</p>}
      </div>}
    </> : mode === 'save' ? <>
      <label className="form-label" htmlFor={nameId}>{t('notepad.name')}</label>
      <input id={nameId} className="text-input" data-autofocus autoComplete="off" maxLength={80} value={name}
        onChange={(event) => setName(event.target.value)} />
      <p className="notepad-files-hint">{t('notepad.localCopy')}</p>
    </> : <>
      <Select aria-label={t('notepad.format')} value={format} onValueChange={(value) => setFormat(value as NoteExportFormat)}
        options={[{ value: 'md', label: 'Markdown (.md)' }, { value: 'txt', label: t('notepad.plainText') }, { value: 'html', label: t('notepad.richText') }]} />
      <p className="notepad-files-hint">{t('notepad.exportHint')}</p>
    </>}
    {error && <p className="notepad-files-error" role="alert">{error}</p>}
  </ModalDialog>;
}
