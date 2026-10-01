import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
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
import { showToast } from '../hooks/useToast';
import { useRoom } from '../hooks/useRoom';
import { useTextEditorContextMenu } from '../hooks/useTextEditorContextMenu';

interface Props { instanceId: string; compact?: boolean }

function actorColor(actor: string): string {
  let hash = 0;
  for (const char of actor) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ['#6aa9ff', '#f29a62', '#7bcba5', '#c7a2f5', '#f17e9c', '#e6ba61'][Math.abs(hash) % 6];
}

export const NotepadApp: React.FC<Props> = ({ instanceId, compact = false }) => {
  const { username } = useRoom();
  const model = roomAppsService.getModel<NotepadModel>(instanceId);
  const [busy, setBusy] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const user = useMemo(() => ({ name: username || 'Você', color: actorColor(roomAppsService.getLocalActor()) }), [username]);
  const editor = useEditor({
    immediatelyRender: false,
    editable: !compact,
    extensions: [
      StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true, linkOnPaste: true } }),
      Markdown,
      Placeholder.configure({ placeholder: 'Comece a escrever com a sala...' }),
      Underline,
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TableKit,
      Collaboration.configure({ fragment: model?.richContent }),
      CollaborationCaret.configure({ provider: { awareness: model?.awareness }, user }),
    ],
    editorProps: { attributes: { class: 'room-app-notepad-editor', 'aria-label': 'Nota compartilhada',
      'aria-multiline': 'true' } },
  }, [instanceId, model]);

  useTextEditorContextMenu(editor);
  useEffect(() => { editor?.setEditable(!compact); }, [editor, compact]);
  useEffect(() => { if (editor) editor.commands.updateUser(user); }, [editor, user]);

  const open = async () => {
    if (!editor) return;
    setBusy(true);
    try {
      const file = await invoke<[string, string] | null>('open_note_file');
      if (file !== null) editor.commands.setContent(file[0], file[1] === 'html' ? {} : { contentType: 'markdown' });
    } catch (error) { showToast(`Erro ao abrir nota: ${error}`); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!editor) return;
    setBusy(true);
    try {
      const saved = await invoke<boolean>('save_note_file', { content: editor.getHTML() });
      if (saved) showToast('Nota salva no computador');
    } catch (error) { showToast(`Erro ao salvar nota: ${error}`); }
    finally { setBusy(false); }
  };
  const applyLink = () => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) { showToast('Use um link http ou https.'); return; }
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    else editor.chain().focus().unsetLink().run();
    setEditingLink(false);
    setLinkUrl('');
  };

  return <div className={`room-app-notepad ${compact ? 'compact' : ''}`}
    onClick={(event) => event.stopPropagation()}>
    {!compact && <>
      {editor && <NotepadToolbar editor={editor} onLink={() => {
        setLinkUrl(editor.getAttributes('link').href || ''); setEditingLink(true);
      }} fileActions={<>
        <button className="btn btn-sm btn-outline" disabled={busy} onClick={open}>Abrir</button>
        <button className="btn btn-sm btn-outline" disabled={busy} onClick={save}>Salvar</button>
      </>} />}
      {editingLink && <div className="room-app-notepad-link">
        <input autoComplete="off" aria-label="URL do link" autoFocus value={linkUrl} placeholder="https://..."
          onChange={(event) => setLinkUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') applyLink(); if (event.key === 'Escape') setEditingLink(false); }} />
        <button className="btn btn-sm btn-outline" onClick={applyLink}>Aplicar</button>
        <button className="btn btn-sm btn-outline" onClick={() => setEditingLink(false)}>Cancelar</button>
      </div>}
    </>}
    <EditorContent editor={editor} className="room-app-notepad-content" />
  </div>;
};
