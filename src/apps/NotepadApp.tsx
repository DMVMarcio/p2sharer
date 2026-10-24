import { localizeError, getLanguage, t } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../platform/commands.ts';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Download, FilePlus2, FolderOpen, Save } from 'lucide-react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlockExtension } from '../components/common/CodeBlockExtension';
import { CodeEditing } from '../components/common/CodeEditing';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import { roomAppsService } from './room_apps_service';
import { NotepadModel } from './models.ts';
import { NotepadToolbar } from './NotepadToolbar';
import { createNotepadImageExtension, initialNoteImageDimensions } from './NotepadImageExtension';
import {
  pickWhiteboardImage, prepareWhiteboardImage, readClipboardImageDataUrl,
  validHttpImageUrl, type WhiteboardImageRecord,
} from './whiteboard_image';
import { boardError } from './useWhiteboardFiles';
import { showToast } from '../hooks/useToast';
import { useRoom } from '../hooks/useRoom';
import { useTextEditorContextMenu } from '../hooks/useTextEditorContextMenu';
import { ModalDialog } from '../components/common/ModalDialog';
import { useDocumentLibraryDeletion } from './useDocumentLibraryDeletion';
import { NotepadFilesDialog, type SavedNote, type NoteLibrary, type NoteExportFormat } from './NotepadFilesDialog';

interface Props { instanceId: string; compact?: boolean }

const IMAGE_PATH_RE = /\.(png|apng|jpe?g|webp|gif)$/i;

function actorColor(actor: string): string {
  let hash = 0;
  for (const char of actor) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ['#6aa9ff', '#f29a62', '#7bcba5', '#c7a2f5', '#f17e9c', '#e6ba61'][Math.abs(hash) % 6];
}

function hasClipboardImage(clipboardData?: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  return Array.from(clipboardData.items ?? []).some(item => item.type.startsWith('image/')) ||
    Array.from(clipboardData.files ?? []).some(file => file.type.startsWith('image/'));
}

function hasClipboardText(clipboardData?: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  return Boolean(clipboardData.getData('text/plain') || clipboardData.getData('text/html'));
}

export const NotepadApp: React.FC<Props> = ({ instanceId, compact = false }) => {
  const language = useLocale();
  const { username } = useRoom();
  const model = roomAppsService.getModel<NotepadModel>(instanceId);
  const rootRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [editingImage, setEditingImage] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [dialog, setDialog] = useState<'open' | 'save' | 'export' | null>(null);
  const [pending, setPending] = useState<SavedNote | { content: string; format: string } | 'new' | null>(null);
  const [, setRevision] = useState(0);
  const saved = useRef(new Map<string, SavedNote>());
  const deleted = useRef(new Set<string>());
  const forgetSaved = (id: string) => { deleted.current.add(id); saved.current.delete(id); setRevision(value => value + 1); };
  useDocumentLibraryDeletion('notes', forgetSaved);
  const saveTarget = useRef(instanceId);
  const approvedReplacement = useRef<NonNullable<typeof pending> | null>(null);
  const identity = model?.noteIdentity;
  const user = useMemo(() => ({ name: username || t("message.b21e91730d18"), color: actorColor(roomAppsService.getLocalActor()) }), [username]);
  const editor = useEditor({
    immediatelyRender: false,
    editable: !compact,
    extensions: [
      StarterKit.configure({ codeBlock: false, undoRedo: false, underline: false, link: { openOnClick: false, autolink: true, linkOnPaste: true } }),
      CodeBlockExtension,
      CodeEditing.configure({ plainTextTab: true }),
      Markdown,
      Placeholder.configure({ placeholder: () => t("message.ddf4b9ab9b48") }),
      Underline,
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TableKit,
      createNotepadImageExtension(model),
      Collaboration.configure({ fragment: model?.richContent }),
      CollaborationCaret.configure({ provider: { awareness: model?.awareness }, user }),
    ],
    editorProps: { attributes: { class: 'room-app-notepad-editor', 'aria-label': t("message.29a978697f6f"),
      'aria-multiline': 'true' } },
  }, [instanceId, model]);

  useTextEditorContextMenu(editor);
  useEffect(() => {
    if (!editor) return;
    editor.setOptions({ editorProps: { attributes: { class: 'room-app-notepad-editor',
      'aria-label': t("message.29a978697f6f"), 'aria-multiline': 'true' } } });
    editor.view.dispatch(editor.state.tr.setMeta('preventUpdate', true));
  }, [editor, language]);
  useEffect(() => { editor?.setEditable(!compact); }, [editor, compact]);
  useEffect(() => { if (editor) editor.commands.updateUser(user); }, [editor, user]);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    const unsubscribe = model?.subscribe(changed);
    model?.document.on('update', changed);
    editor?.on('update', changed);
    return () => { unsubscribe?.(); model?.document.off('update', changed); editor?.off('update', changed); };
  }, [model, editor]);
  useEffect(() => {
    const id = identity?.id ?? instanceId;
    if (saved.current.has(id)) return;
    let active = true;
    void (async () => {
      try {
        const library = await invoke<NoteLibrary>('list_saved_notes');
        if (!active || !library.notes.some((note) => note.id === id)) return;
        const note = await invoke<SavedNote>('read_saved_note', { id });
        if (active && !saved.current.has(id) && !deleted.current.has(id)) {
          saved.current.set(id, note);
          setRevision((value) => value + 1);
        }
      } catch { /* Explicit Open and Save actions surface disk errors. */ }
    })();
    return () => { active = false; };
  }, [identity?.id, instanceId]);
  const insertNoteImage = (image: WhiteboardImageRecord, dropPoint?: { clientX: number; clientY: number }) => {
    if (!editor || !model) return;
    model.registerImage(image);
    const { width, height } = initialNoteImageDimensions(image.width, image.height);
    const node = { type: 'image', attrs: { src: `p2image:${image.hash}`, width, height } };
    if (dropPoint && editor.view.dom.clientWidth > 0 && editor.view.dom.clientHeight > 0) {
      try {
        const coords = editor.view.posAtCoords({ left: dropPoint.clientX, top: dropPoint.clientY });
        if (coords && coords.inside >= 0 && coords.pos > 0) {
          editor.commands.setTextSelection(coords.pos);
        }
      } catch { /* ignore layout lookup errors */ }
    }
    editor.chain().focus().insertContent(node).run();
  };
  const pasteImage = async (
    clipboardData?: DataTransfer | null,
    dropPoint?: { clientX: number; clientY: number },
    filePath?: string,
  ) => {
    if (!editor || !model || compact) return;
    try {
      const dataUrl = filePath ? undefined : await readClipboardImageDataUrl(clipboardData);
      const image = await prepareWhiteboardImage(dataUrl, filePath);
      insertNoteImage(image, dropPoint);
    } catch (reason) {
      showToast(boardError(reason), 3500, 'error');
    }
  };
  const pasteImageRef = useRef(pasteImage);
  pasteImageRef.current = pasteImage;
  useEffect(() => {
    if (compact || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed || event.payload.type !== 'drop' || !event.payload.paths.length) return;
      const filePath = event.payload.paths.find(p => IMAGE_PATH_RE.test(p));
      if (!filePath) return;
      const container = rootRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const logical = { clientX: event.payload.position.x / dpr, clientY: event.payload.position.y / dpr };
      const raw = { clientX: event.payload.position.x, clientY: event.payload.position.y };
      const inside = (pt: { clientX: number; clientY: number }) =>
        pt.clientX >= rect.left && pt.clientX <= rect.right && pt.clientY >= rect.top && pt.clientY <= rect.bottom;
      const dropPoint = inside(logical) ? logical : inside(raw) ? raw : null;
      if (!dropPoint) return;
      void pasteImageRef.current(null, dropPoint, filePath);
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [compact]);
  const chooseImageFile = async () => {
    if (!editor || !model || busy) return;
    setBusy(true);
    try {
      const image = await pickWhiteboardImage();
      if (!image) return;
      insertNoteImage(image);
      setEditingImage(false);
      setImageUrl('');
    } catch (reason) {
      showToast(boardError(reason), 3500, 'error');
    } finally {
      setBusy(false);
    }
  };
  const applyImageUrl = async () => {
    if (!editor || !model || busy) return;
    const url = imageUrl.trim();
    if (!validHttpImageUrl(url)) {
      showToast(t('message.26af686b13f7'));
      return;
    }
    setBusy(true);
    try {
      const image = await prepareWhiteboardImage(undefined, undefined, url);
      insertNoteImage(image);
      setEditingImage(false);
      setImageUrl('');
    } catch (reason) {
      showToast(boardError(reason), 3500, 'error');
    } finally {
      setBusy(false);
    }
  };
  const replace = (note: NonNullable<typeof pending>) => {
    if (!editor || !model) return;
    model.document.transact(() => {
      if (note === 'new') {
        editor.commands.clearContent();
        model.setNoteIdentity(crypto.randomUUID(), t('notepad.untitled'));
      } else {
        if ('id' in note || note.format === 'html') editor.commands.setContent(note.content);
        else if (note.format === 'txt') editor.commands.setContent({ type: 'doc', content: note.content.split(/\r?\n/).map((line) => ({
          type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}),
        })) });
        else editor.commands.setContent(note.content, { contentType: 'markdown' });
        if ('id' in note) {
          model.setNoteIdentity(note.id, note.name);
          saved.current.set(note.id, { ...note, content: editor.getHTML() });
        } else model.setNoteIdentity(crypto.randomUUID(), t('notepad.untitled'));
      }
    });
    setPending(null);
    editor.commands.focus();
  };
  const requestReplace = (note: NonNullable<typeof pending>) => {
    if (editor && !editor.isEmpty) setPending(note);
    else replace(note);
  };
  const persist = async (name: string, expectedId: string, overwrite?: SavedNote) => {
    if (!editor || !model) return;
    const id = model.noteIdentity?.id ?? instanceId;
    if (id !== expectedId) throw new Error(t('notepad.documentChanged'));
    const content = editor.getHTML();
    const previous = saved.current.get(id);
    const library = previous ? null : await invoke<NoteLibrary>('list_saved_notes');
    const existing = overwrite ?? previous ?? library?.notes.find((note) => note.id === id);
    const note = await invoke<SavedNote>('save_library_note', { id: overwrite?.id ?? id, name, content, expectedUpdatedAt: existing?.updatedAt ?? null });
    deleted.current.delete(note.id); saved.current.set(note.id, note);
    // Keep a delayed save from relabeling another document opened by a peer.
    if ((model.noteIdentity?.id ?? instanceId) === id) model.setNoteIdentity(note.id, note.name);
    setRevision((value) => value + 1);
    showToast(t('message.6896081fcc11'), 3500, 'success');
  };
  const save = async () => {
    if (!editor || busy) return;
    setBusy(true);
    try {
      const id = identity?.id ?? instanceId;
      const existing = saved.current.get(id) ?? (await invoke<NoteLibrary>('list_saved_notes')).notes.find((note) => note.id === id);
      if ((model?.noteIdentity?.id ?? instanceId) !== id) throw new Error(t('notepad.documentChanged'));
      if (existing) await persist(existing.name, id);
      else { saveTarget.current = id; setDialog('save'); }
    } catch (error) { showToast(t("message.9e3916f5a733", { v0: localizeError(error) }), 3500, 'error'); }
    finally { setBusy(false); }
  };
  const exportNote = async (format: NoteExportFormat) => {
    if (!editor) return;
    const content = format === 'html' ? editor.getHTML() : format === 'md' ? editor.getMarkdown() : editor.getText({ blockSeparator: '\n' });
    if (await invoke<boolean>('save_note_file', { content, format, language: getLanguage() }))
      showToast(t('notepad.exported'), 3500, 'success');
  };
  const localNote = saved.current.get(identity?.id ?? instanceId);
  const clean = Boolean(localNote && localNote.content === editor?.getHTML());
  const applyLink = () => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) { showToast(t("message.26af686b13f7")); return; }
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    else editor.chain().focus().unsetLink().run();
    setEditingLink(false);
    setLinkUrl('');
  };

  return <div ref={rootRef} className={`room-app-notepad ${compact ? 'compact' : ''}`}
    onDragOver={(event) => {
      if (compact) return;
      const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files') ||
        Array.from(event.dataTransfer?.items ?? []).some(item => item.type.startsWith('image/'));
      if (hasFiles) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    }}
    onDropCapture={(event) => {
      if (compact) return;
      const hasImage = Array.from(event.dataTransfer?.files ?? []).some(file => file.type.startsWith('image/'));
      if (!hasImage) return;
      event.preventDefault();
      event.stopPropagation();
      void pasteImage(event.dataTransfer, { clientX: event.clientX, clientY: event.clientY });
    }}
    onPasteCapture={(event) => {
      if (compact) return;
      const inInput = event.target instanceof Element && Boolean(event.target.closest('input, textarea'));
      if (hasClipboardImage(event.clipboardData) || (!inInput && !hasClipboardText(event.clipboardData) && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)) {
        event.preventDefault();
        event.stopPropagation();
        void pasteImage(event.clipboardData);
      }
    }}
    onKeyDown={(event) => { if (!compact && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); if (!dialog && !pending) void save();
    } }}
    onClick={(event) => event.stopPropagation()}>
    {!compact && <>
      {editor && <NotepadToolbar editor={editor} onLink={() => {
        setEditingImage(false); setLinkUrl(editor.getAttributes('link').href || ''); setEditingLink(true);
      }} onImage={() => {
        setEditingLink(false); setEditingImage(prev => !prev);
      }} imageActive={editingImage} fileActions={<>
        <div className="room-app-toolbar-actions">
          <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => requestReplace('new')}><FilePlus2 size={14} aria-hidden="true" />{t('notepad.new')}</button>
          <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => setDialog('open')}><FolderOpen size={14} aria-hidden="true" />{t("message.a01a5fce396e")}</button>
        </div>
        <div className="room-app-toolbar-actions">
          <button className="btn btn-sm btn-outline" disabled={busy} onClick={save}><Save size={14} aria-hidden="true" />{t("message.aef7cd5b2081")}</button>
          <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => setDialog('export')}><Download size={14} aria-hidden="true" />{t('notepad.export')}</button>
        </div>
      </>} />}
      <div className="notepad-file-status" role="status"><strong>{identity?.name ?? t('notepad.untitled')}</strong>
        <span>{t(busy ? 'notepad.saving' : clean ? 'notepad.saved' : localNote ? 'notepad.modified' : 'notepad.unsaved')}</span></div>
      {editingLink && <div className="room-app-notepad-link">
        <input autoComplete="off" aria-label={t("message.43179cc649ca")} autoFocus value={linkUrl} placeholder="https://..."
          onChange={(event) => setLinkUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') applyLink(); if (event.key === 'Escape') setEditingLink(false); }} />
        <button className="btn btn-sm btn-outline" onClick={applyLink}>{t("message.3a04898a6b8b")}</button>
        <button className="btn btn-sm btn-outline" onClick={() => setEditingLink(false)}>{t("message.bb9dbb406dcb")}</button>
      </div>}
      {editingImage && <div className="room-app-notepad-link">
        <input autoComplete="off" aria-label={t('notepad.imageUrl')} autoFocus value={imageUrl} placeholder="https://..."
          onChange={(event) => setImageUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void applyImageUrl(); if (event.key === 'Escape') setEditingImage(false); }} />
        <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => void applyImageUrl()}>{t("message.3a04898a6b8b")}</button>
        <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => void chooseImageFile()}><FolderOpen size={14} aria-hidden="true" />{t('notepad.chooseImage')}</button>
        <button className="btn btn-sm btn-outline" onClick={() => setEditingImage(false)}>{t("message.bb9dbb406dcb")}</button>
      </div>}
    </>}
    <EditorContent editor={editor} className="room-app-notepad-content" />
    {dialog && <NotepadFilesDialog mode={dialog} initialName={identity?.name ?? t('notepad.untitled')}
      onOpen={requestReplace} onSave={(name, overwrite) => persist(name, saveTarget.current, overwrite)}
      onDelete={forgetSaved}
      onRename={note => { deleted.current.delete(note.id); saved.current.set(note.id, note);
        if ((model?.noteIdentity?.id ?? instanceId) === note.id) model?.setNoteIdentity(note.id, note.name);
        setRevision(value => value + 1);
      }} onExport={exportNote} onClose={() => setDialog(null)} />}
    {pending && !dialog && <ModalDialog title={t('notepad.replaceTitle')} onClose={() => {
      const note = approvedReplacement.current; approvedReplacement.current = null;
      if (note) replace(note); else setPending(null);
    }}
      footer={(close) => <>
        <button className="btn btn-secondary" data-autofocus onClick={close}>{t('message.bb9dbb406dcb')}</button>
        <button className="btn btn-primary" onClick={() => { approvedReplacement.current = pending; close(); }}>{t('notepad.replace')}</button>
      </>}><p>{t('notepad.replaceHint')}</p></ModalDialog>}
  </div>;
};
