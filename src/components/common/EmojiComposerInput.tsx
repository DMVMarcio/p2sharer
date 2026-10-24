import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
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
import { CodeBlockExtension } from './CodeBlockExtension';
import { CodeEditing } from './CodeEditing';
import { useTextEditorContextMenu } from '../../hooks/useTextEditorContextMenu';

export type EmojiComposerHandle = {
  insertEmoji: (emoji: string) => void;
  focus: () => void;
  getMarkdown: () => string;
  hasText: () => boolean;
  replaceRange: (range: { from: number; to: number }, text: string) => void;
};

type Props = {
  id?: string;
  value: string;
  pack: EmojiPack;
  onChange: (value: string) => void;
  onSend: () => void;
  onMentionQueryChange?: (query: string | null, range: { from: number; to: number } | null) => void;
  onMentionKeyDown?: (key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape') => boolean;
  mentionActive?: boolean;
};

function FormatButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  useLocale();
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

function checkMentionQuery(editorInstance: NonNullable<ReturnType<typeof useEditor>>): { query: string; range: { from: number; to: number } } | null {
  const { from, empty } = editorInstance.state.selection;
  if (!empty) return null;
  const $from = editorInstance.state.selection.$from;
  if ($from.parent.type.spec.code) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const match = /(?:^|\s)@([^\s@]*)$/.exec(textBefore);
  if (!match) return null;
  const query = match[1];
  const matchStartOffset = match.index + (match[0].startsWith('@') ? 0 : 1);
  const startPos = $from.start() + matchStartOffset;
  const endPos = from;
  return { query, range: { from: startPos, to: endPos } };
}

export const EmojiComposerInput = forwardRef<EmojiComposerHandle, Props>(function EmojiComposerInput({
  id = 'chat-input-field',
  value,
  pack,
  onChange,
  onSend,
  onMentionQueryChange,
  onMentionKeyDown,
  mentionActive = false,
}, ref) {
  const language = useLocale();
  const packRef = useRef(pack);
  const onChangeRef = useRef(onChange);
  const onSendRef = useRef(onSend);
  const onMentionQueryChangeRef = useRef(onMentionQueryChange);
  const onMentionKeyDownRef = useRef(onMentionKeyDown);
  const mentionActiveRef = useRef(mentionActive);
  const editingLinkRef = useRef(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [editingLink, setEditingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState(false);
  packRef.current = pack;
  onChangeRef.current = onChange;
  onSendRef.current = onSend;
  onMentionQueryChangeRef.current = onMentionQueryChange;
  onMentionKeyDownRef.current = onMentionKeyDown;
  mentionActiveRef.current = mentionActive;
  editingLinkRef.current = editingLink;

  const editor = useEditor({
    immediatelyRender: false,
    content: value,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true, linkOnPaste: true } }),
      CodeBlockExtension,
      CodeEditing,
      Markdown,
      CharacterCount.configure({ limit: 2000 }),
      Placeholder.configure({ placeholder: () => t("message.886fe94fce87") }),
      ChatEmojiDecorations.configure({ getPack: () => packRef.current }),
    ],
    editorProps: {
      attributes: {
        id,
        class: 'chat-composer-editor',
        'aria-label': t("message.322085898310"),
        'aria-multiline': 'true',
        'data-placeholder': t("message.886fe94fce87"),
      },
      handleKeyDown: (_view, event) => {
        if (mentionActiveRef.current) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') {
            const handled = onMentionKeyDownRef.current?.(event.key);
            if (handled) {
              event.preventDefault();
              return true;
            }
          }
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
            (!_view.state.selection.$from.parent.type.spec.code || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          onSendRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      onChangeRef.current(current.getMarkdown());
      if (onMentionQueryChangeRef.current) {
        const res = checkMentionQuery(current);
        onMentionQueryChangeRef.current(res ? res.query : null, res ? res.range : null);
      }
    },
    onSelectionUpdate: ({ editor: current }) => {
      if (onMentionQueryChangeRef.current) {
        const res = checkMentionQuery(current);
        onMentionQueryChangeRef.current(res ? res.query : null, res ? res.range : null);
      }
    },
  }, []);

  useTextEditorContextMenu(editor);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: {
      id, class: 'chat-composer-editor', 'aria-label': t("message.322085898310"),
      'aria-multiline': 'true', 'data-placeholder': t("message.886fe94fce87"),
    } } });
    editor.view.dispatch(editor.state.tr.setMeta('preventUpdate', true));
  }, [editor, id, language]);

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
    replaceRange(range, text) {
      if (!editor) return;
      editor.chain().focus().deleteRange(range).insertContent(text).run();
    },
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
              <input autoComplete="off"
                ref={linkInputRef}
                type="url"
                value={linkUrl}
                placeholder="https://..."
                aria-label={t("message.1b5ae5aaa05e")}
                aria-invalid={linkError}
                onChange={(event) => { setLinkUrl(event.target.value); setLinkError(false); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
                  if (event.key === 'Escape') { editingLinkRef.current = false; setEditingLink(false); editor.commands.focus(); }
                }}
              />
              <FormatButton label={t("message.c04ad55d44a6")} onClick={applyLink}><Check size={15} /></FormatButton>
              <FormatButton label={t("message.bb9dbb406dcb")} onClick={() => { editingLinkRef.current = false; setEditingLink(false); editor.commands.focus(); }}><X size={15} /></FormatButton>
            </div>
          ) : (
            <div className="chat-format-actions">
              <FormatButton label={t("message.0466381bc96d")} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></FormatButton>
              <FormatButton label={t("message.698a73c21e2d")} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></FormatButton>
              <FormatButton label={t("message.dce3e1ac320a")} active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></FormatButton>
              <FormatButton label={t("message.f58b85570398")} active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={15} /></FormatButton>
              <FormatButton label="Link" active={editor.isActive('link')} onClick={startLink}><Link2 size={15} /></FormatButton>
              <span className="chat-format-divider" aria-hidden="true" />
              <FormatButton label={t("message.a3132c798df1")} active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={15} /></FormatButton>
              <FormatButton label={t("message.5e77e1785d57")} active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></FormatButton>
              <FormatButton label={t("message.089e8d86c7f3")} active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></FormatButton>
              <FormatButton label={t("message.45b49b8b0365")} active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code2 size={15} /></FormatButton>
            </div>
          )}
        </BubbleMenu>
      )}
    </div>
  );
});
