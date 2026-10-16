import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FilePlus2, FolderOpen, Save, Download } from 'lucide-react';
import { DocumentFilesDialog, type NoteLibrary, type SavedNote } from './NotepadFilesDialog';
import { ModalDialog } from '../components/common/ModalDialog';
import { showToast } from '../hooks/useToast';
import { getLanguage, localizeError, t } from '../i18n';
import type { WhiteboardModel } from './whiteboard_model';
import { boardSvg, parseBoardFile } from './whiteboard_scene';
import { boardPng } from './whiteboard_export';

export function boardError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('whiteboard.') || message === 'documents.nameExists' ? t(message) : localizeError(error);
}
type Replacement = SavedNote | { content: string; format: string } | 'new';
export function useWhiteboardFiles(model: WhiteboardModel | undefined, instanceId: string) {
  const [dialog, setDialog] = useState<'open' | 'save' | 'export' | null>(null);
  const [pending, setPending] = useState<Replacement | null>(null);
  const [busy, setBusy] = useState(false);
  const [, refresh] = useState(0);
  const saved = useRef(new Map<string, SavedNote>());
  const target = useRef(instanceId);
  const approved = useRef<Replacement | null>(null);
  const id = model?.identity?.id ?? instanceId;
  const name = model?.identity?.name ?? t('whiteboard.untitled');
  useEffect(() => {
    let active = true;
    if (!saved.current.has(id)) void invoke<NoteLibrary>('list_saved_notes', { library: 'whiteboard' }).then(async library => {
      if (!active || !library.notes.some(note => note.id === id)) return;
      const note = await invoke<SavedNote>('read_saved_note', { id, library: 'whiteboard' });
      if (active && !saved.current.has(id)) { saved.current.set(id, note); refresh(n => n + 1); }
    }).catch(() => {});
    return () => { active = false; };
  }, [id]);
  const persist = async (name: string, expectedId: string, overwrite?: SavedNote) => {
    if (!model) return;
    if ((model.identity?.id ?? instanceId) !== expectedId) throw new Error('whiteboard.documentChanged');
    const content = model.content;
    const existing = overwrite ?? saved.current.get(expectedId) ?? (await invoke<NoteLibrary>('list_saved_notes', { library: 'whiteboard' })).notes.find(note => note.id === expectedId);
    const note = await invoke<SavedNote>('save_library_note', { id: overwrite?.id ?? expectedId, name, content,
      expectedUpdatedAt: existing?.updatedAt ?? null, library: 'whiteboard' });
    saved.current.set(note.id, note);
    if ((model.identity?.id ?? instanceId) === expectedId) model.setIdentity(note.id, note.name);
    refresh(n => n + 1); showToast(t('message.6896081fcc11'), 3500, 'success');
  };
  const save = async () => {
    if (busy || !model || dialog || pending) return;
    setBusy(true);
    try {
      const existing = saved.current.get(id) ?? (await invoke<NoteLibrary>('list_saved_notes', { library: 'whiteboard' })).notes.find(note => note.id === id);
      if ((model.identity?.id ?? instanceId) !== id) throw new Error('whiteboard.documentChanged');
      if (existing) await persist(existing.name, id);
      else { target.current = id; setDialog('save'); }
    } catch (error) { showToast(boardError(error), 3500, 'error'); }
    finally { setBusy(false); }
  };
  const replace = (note: Replacement) => {
    try {
      model?.replace(note === 'new' ? '{"version":1,"shapes":[]}' : note.content,
        note !== 'new' && 'id' in note ? note.id : crypto.randomUUID(), note !== 'new' && 'name' in note ? note.name : t('whiteboard.untitled'));
      if (note !== 'new' && 'id' in note) saved.current.set(note.id, note);
    } catch (error) { showToast(boardError(error), 3500, 'error'); }
    setPending(null);
  };
  const requestReplace = (note: Replacement) => {
    if (note !== 'new') { try { parseBoardFile(note.content); } catch { throw new Error(t('whiteboard.invalidFile')); } }
    if (model?.shapes.length) setPending(note); else replace(note);
  };
  const local = saved.current.get(id);
  return {
    save,
    actions: <div className="room-app-toolbar-actions room-app-notepad-file-actions">
      <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => requestReplace('new')}><FilePlus2 size={14} />{t('notepad.new')}</button>
      <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => setDialog('open')}><FolderOpen size={14} />{t('message.a01a5fce396e')}</button>
      <button className="btn btn-sm btn-outline" disabled={busy} onClick={save}><Save size={14} />{t('notepad.save')}</button>
      <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => setDialog('export')}><Download size={14} />{t('notepad.export')}</button>
    </div>,
    status: <div className="notepad-file-status" role="status"><strong>{name}</strong><span>{t(busy ? 'notepad.saving' : local?.content === model?.content ? 'notepad.saved' : local ? 'notepad.modified' : 'notepad.unsaved')}</span></div>,
    dialogs: <>{dialog && <DocumentFilesDialog mode={dialog} library="whiteboard" initialName={name} onOpen={requestReplace}
      onSave={async (name, overwrite) => { try { await persist(name, target.current, overwrite); } catch (error) { throw new Error(boardError(error)); } }}
      onRename={note => { saved.current.set(note.id, note);
        if ((model?.identity?.id ?? instanceId) === note.id) model?.setIdentity(note.id, note.name);
        refresh(n => n + 1);
      }}
      onExport={async format => {
        if (!model) return;
        const content = format === 'png' ? await boardPng(model.shapes, model.layers) : format === 'svg' ? boardSvg(model.shapes, model.layers) : model.content;
        if (await invoke<boolean>('save_note_file', { library: 'whiteboard', content, format, language: getLanguage() }))
          showToast(t('whiteboard.exported'), 3500, 'success');
      }} onClose={() => setDialog(null)} />}
      {pending && !dialog && <ModalDialog title={t('whiteboard.replaceTitle')} onClose={() => {
        const note = approved.current; approved.current = null; if (note) replace(note); else setPending(null);
      }} footer={close => <>
        <button className="btn btn-secondary" data-autofocus onClick={close}>{t('message.bb9dbb406dcb')}</button>
        <button className="btn btn-primary" onClick={() => { approved.current = pending; close(); }}>{t('notepad.replace')}</button>
      </>}><p>{t('whiteboard.replaceHint')}</p></ModalDialog>}</>,
  };
}
