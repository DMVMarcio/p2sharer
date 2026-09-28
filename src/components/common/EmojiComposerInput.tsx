import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import CharacterCount from '@tiptap/extension-character-count';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, Strikethrough, Code, Code2, Link2, Quote, List, ListOrdered, Check, X } from 'lucide-react';
import type { EmojiPack } from '../../core/emoji_preferences';
import { safeChatUrl } from '../../core/chat_links';
import { ChatEmojiDecorations } from './ChatEmojiDecorations';

export type EmojiComposerHandle = {
  insertEmoji: (emoji: string) => void;
  focus: () => void;
  getMarkdown: () => string;
  hasText: () => boolean;
};

type Props = {
  value: string;
  pack: EmojiPack;
  onChange: (value: string) => void;
  onSend: () => void;
};

function FormatButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`chat-format-button ${active ? 'active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >{children}</button>
  );
}

export const EmojiComposerInput = forwardRef<EmojiComposerHandle, Props>(function EmojiComposerInput({ value, pack, onChange, onSend }, ref) {
  const packRef = useRef(pack);
  const onChangeRef = useRef(onChange);
  const onSendRef = useRef(onSend);
  const editingLinkRef = useRef(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [editingLink, setEditingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState(false);
  packRef.current = pack;
  onChangeRef.current = onChange;
  onSendRef.current = onSend;
  editingLinkRef.current = editingLink;

  const editor = useEditor({
    immediatelyRender: false,
    content: value,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, linkOnPaste: true } }),
      Markdown,
      CharacterCount.configure({ limit: 2000 }),
      Placeholder.configure({ placeholder: 'Digite uma mensagem...' }),
      ChatEmojiDecorations.configure({ getPack: () => packRef.current }),
    ],
    editorProps: {
      attributes: {
        id: 'chat-input-field',
        class: 'chat-composer-editor',
        'aria-label': 'Mensagem',
        'aria-multiline': 'true',
        'data-placeholder': 'Digite uma mensagem...',
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          onSendRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => onChangeRef.current(current.getMarkdown()),
  }, []);

  useEffect(() => {
    if (!editor) return;
    if (editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr.setMeta('emoji-pack', pack));
  }, [editor, pack]);

  useImperativeHandle(ref, () => ({
    insertEmoji(emoji) { editor?.chain().focus().insertContent(emoji).run(); },
    focus() { editor?.commands.focus(); },
    getMarkdown() { return editor?.getMarkdown() ?? ''; },
    hasText() { return Boolean(editor?.getText().trim()); },
  }), [editor]);

  const startLink = () => {
    if (!editor) return;
    setLinkUrl(editor.getAttributes('link').href ?? '');
    setLinkError(false);
    editingLinkRef.current = true;
    setEditingLink(true);
    requestAnimationFrame(() => linkInputRef.current?.focus());
  };

  const applyLink = () => {
    if (!editor) return;
    if (!linkUrl.trim()) editor.chain().focus().unsetLink().run();
    else {
      const href = safeChatUrl(linkUrl.trim());
      if (!href) { setLinkError(true); return; }
      editor.chain().focus().setLink({ href }).run();
    }
    editingLinkRef.current = false;
    setEditingLink(false);
    setLinkError(false);
  };

  return (
    <div className="chat-composer-field">
      <EditorContent editor={editor} />
      {editor && (
        <BubbleMenu
          editor={editor}
          className="chat-format-bubble"
          appendTo={() => document.body}
          shouldShow={({ editor: current, state }) => !state.selection.empty && (current.isFocused || editingLinkRef.current)}
          options={{ placement: 'top', offset: 8, flip: true, shift: true }}
        >
          {editingLink ? (
            <div className="chat-format-link">
              <input
                ref={linkInputRef}
                type="url"
                value={linkUrl}
                placeholder="https://..."
                aria-label="Endereço do link"
                aria-invalid={linkError}
                onChange={(event) => { setLinkUrl(event.target.value); setLinkError(false); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
                  if (event.key === 'Escape') { editingLinkRef.current = false; setEditingLink(false); editor.commands.focus(); }
                }}
              />
              <FormatButton label="Aplicar link" onClick={applyLink}><Check size={15} /></FormatButton>
              <FormatButton label="Cancelar" onClick={() => { editingLinkRef.current = false; setEditingLink(false); editor.commands.focus(); }}><X size={15} /></FormatButton>
            </div>
          ) : (
            <div className="chat-format-actions">
              <FormatButton label="Negrito" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></FormatButton>
              <FormatButton label="Itálico" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></FormatButton>
              <FormatButton label="Riscado" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></FormatButton>
              <FormatButton label="Código" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={15} /></FormatButton>
              <FormatButton label="Link" active={editor.isActive('link')} onClick={startLink}><Link2 size={15} /></FormatButton>
              <span className="chat-format-divider" aria-hidden="true" />
              <FormatButton label="Citação" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={15} /></FormatButton>
              <FormatButton label="Lista" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></FormatButton>
              <FormatButton label="Lista numerada" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></FormatButton>
              <FormatButton label="Bloco de código" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code2 size={15} /></FormatButton>
            </div>
          )}
        </BubbleMenu>
      )}
    </div>
  );
});
