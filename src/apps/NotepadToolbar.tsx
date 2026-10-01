import { Select } from '../components/common/Select';
import React from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Code, Highlighter, Italic, Link2,
  List, ListOrdered, Minus, Quote, Redo2, Strikethrough, Table2, TableColumnsSplit,
  TableRowsSplit, Trash2, Underline as UnderlineIcon, Undo2 } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';

interface Props { editor: Editor; onLink(): void; fileActions?: React.ReactNode }

export const NotepadToolbar: React.FC<Props> = ({ editor, onLink, fileActions }) => {
  const active = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'),
    strike: current.isActive('strike'), highlight: current.isActive('highlight'),
    bullet: current.isActive('bulletList'), ordered: current.isActive('orderedList'),
    quote: current.isActive('blockquote'), code: current.isActive('codeBlock'),
    link: current.isActive('link'), table: current.isActive('table'),
    heading: current.getAttributes('heading').level || 0,
    alignment: current.getAttributes('paragraph').textAlign || current.getAttributes('heading').textAlign || 'left',
  }) });
  const tool = (label: string, icon: React.ReactNode, selected: boolean, run: () => void) =>
    <TooltipButton tooltip={label} className={`room-app-notepad-tool ${selected ? 'active' : ''}`}
      aria-pressed={selected} onMouseDown={(event) => event.preventDefault()} onClick={run}>{icon}</TooltipButton>;

  return <div className="room-app-notepad-tools" role="toolbar" aria-label="Formatação da nota">
    <Select className="room-app-notepad-select" aria-label="Estilo do parágrafo" value={active.heading} onValueChange={(value) => {
      const level = Number(value);
      if (level === 0) editor.chain().focus().setParagraph().run();
      else editor.chain().focus().setHeading({ level: level as 1 | 2 | 3 }).run();
    }}
      options={[
        { value: '0', label: 'Texto' },
        { value: '1', label: 'Título 1' },
        { value: '2', label: 'Título 2' },
        { value: '3', label: 'Título 3' },
      ]}
    />
    <span className="room-app-notepad-tools-divider" />
    {tool('Negrito', <Bold size={15} />, active.bold, () => editor.chain().focus().toggleBold().run())}
    {tool('Itálico', <Italic size={15} />, active.italic, () => editor.chain().focus().toggleItalic().run())}
    {tool('Sublinhado', <UnderlineIcon size={15} />, active.underline, () => editor.chain().focus().toggleUnderline().run())}
    {tool('Tachado', <Strikethrough size={15} />, active.strike, () => editor.chain().focus().toggleStrike().run())}
    {tool('Marca-texto', <Highlighter size={15} />, active.highlight, () => editor.chain().focus().toggleHighlight().run())}
    <span className="room-app-notepad-tools-divider" />
    {tool('Lista com marcadores', <List size={15} />, active.bullet, () => editor.chain().focus().toggleBulletList().run())}
    {tool('Lista numerada', <ListOrdered size={15} />, active.ordered, () => editor.chain().focus().toggleOrderedList().run())}
    {tool('Citação', <Quote size={15} />, active.quote, () => editor.chain().focus().toggleBlockquote().run())}
    {tool('Bloco de código', <Code size={15} />, active.code, () => editor.chain().focus().toggleCodeBlock().run())}
    {tool('Linha divisória', <Minus size={15} />, false, () => editor.chain().focus().setHorizontalRule().run())}
    {tool('Link', <Link2 size={15} />, active.link, onLink)}
    <span className="room-app-notepad-tools-divider" />
    {tool('Inserir tabela', <Table2 size={15} />, active.table, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
    {active.table && <>
      {tool('Adicionar linha', <TableRowsSplit size={15} />, false, () => editor.chain().focus().addRowAfter().run())}
      {tool('Adicionar coluna', <TableColumnsSplit size={15} />, false, () => editor.chain().focus().addColumnAfter().run())}
      {tool('Remover tabela', <Trash2 size={15} />, false, () => editor.chain().focus().deleteTable().run())}
    </>}
    <span className="room-app-notepad-tools-divider" />
    {tool('Alinhar à esquerda', <AlignLeft size={15} />, active.alignment === 'left', () => editor.chain().focus().setTextAlign('left').run())}
    {tool('Centralizar', <AlignCenter size={15} />, active.alignment === 'center', () => editor.chain().focus().setTextAlign('center').run())}
    {tool('Alinhar à direita', <AlignRight size={15} />, active.alignment === 'right', () => editor.chain().focus().setTextAlign('right').run())}
    <span className="room-app-notepad-tools-divider" />
    {tool('Desfazer', <Undo2 size={15} />, false, () => editor.chain().focus().undo().run())}
    {tool('Refazer', <Redo2 size={15} />, false, () => editor.chain().focus().redo().run())}
    {fileActions && <div className="room-app-toolbar-actions room-app-notepad-file-actions">{fileActions}</div>}
  </div>;
};
