import { t } from '../i18n';
import { useLocale } from '../hooks/useLocale';
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
  useLocale();
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

  return <div className="room-app-notepad-tools" role="toolbar" aria-label={t("message.2f7d0a593ca6")}>
    <Select className="room-app-notepad-select" aria-label={t("message.aee209ab9cf2")} value={active.heading} onValueChange={(value) => {
      const level = Number(value);
      if (level === 0) editor.chain().focus().setParagraph().run();
      else editor.chain().focus().setHeading({ level: level as 1 | 2 | 3 }).run();
    }}
      options={[
        { value: '0', get label() { return t("message.6df3d6661c09"); } },
        { value: '1', get label() { return t("message.7450bec3bb39"); } },
        { value: '2', get label() { return t("message.8877b9e2999b"); } },
        { value: '3', get label() { return t("message.c4c32fab1de6"); } },
      ]}
    />
    <span className="room-app-notepad-tools-divider" />
    {tool(t("message.0466381bc96d"), <Bold size={15} />, active.bold, () => editor.chain().focus().toggleBold().run())}
    {tool(t("message.698a73c21e2d"), <Italic size={15} />, active.italic, () => editor.chain().focus().toggleItalic().run())}
    {tool(t("message.6b104bc1b9ce"), <UnderlineIcon size={15} />, active.underline, () => editor.chain().focus().toggleUnderline().run())}
    {tool(t("message.543e2c0c0001"), <Strikethrough size={15} />, active.strike, () => editor.chain().focus().toggleStrike().run())}
    {tool(t("message.01a0b53607d7"), <Highlighter size={15} />, active.highlight, () => editor.chain().focus().toggleHighlight().run())}
    <span className="room-app-notepad-tools-divider" />
    {tool(t("message.b49c4630cb87"), <List size={15} />, active.bullet, () => editor.chain().focus().toggleBulletList().run())}
    {tool(t("message.089e8d86c7f3"), <ListOrdered size={15} />, active.ordered, () => editor.chain().focus().toggleOrderedList().run())}
    {tool(t("message.a3132c798df1"), <Quote size={15} />, active.quote, () => editor.chain().focus().toggleBlockquote().run())}
    {tool(t("message.45b49b8b0365"), <Code size={15} />, active.code, () => editor.chain().focus().toggleCodeBlock().run())}
    {tool(t("message.3eebdaf6f213"), <Minus size={15} />, false, () => editor.chain().focus().setHorizontalRule().run())}
    {tool('Link', <Link2 size={15} />, active.link, onLink)}
    <span className="room-app-notepad-tools-divider" />
    {tool(t("message.ac3914c8261a"), <Table2 size={15} />, active.table, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
    {active.table && <>
      {tool(t("message.1877689abf19"), <TableRowsSplit size={15} />, false, () => editor.chain().focus().addRowAfter().run())}
      {tool(t("message.d0dd6c4b7d03"), <TableColumnsSplit size={15} />, false, () => editor.chain().focus().addColumnAfter().run())}
      {tool(t("message.4ecbd5fe56e9"), <Trash2 size={15} />, false, () => editor.chain().focus().deleteTable().run())}
    </>}
    <span className="room-app-notepad-tools-divider" />
    {tool(t("message.90e4c76d3267"), <AlignLeft size={15} />, active.alignment === 'left', () => editor.chain().focus().setTextAlign('left').run())}
    {tool(t("message.ec06e63e74f7"), <AlignCenter size={15} />, active.alignment === 'center', () => editor.chain().focus().setTextAlign('center').run())}
    {tool(t("message.a819e3acc473"), <AlignRight size={15} />, active.alignment === 'right', () => editor.chain().focus().setTextAlign('right').run())}
    <span className="room-app-notepad-tools-divider" />
    {tool(t("message.786b48222848"), <Undo2 size={15} />, false, () => editor.chain().focus().undo().run())}
    {tool(t("message.7b659c9caa5e"), <Redo2 size={15} />, false, () => editor.chain().focus().redo().run())}
    {fileActions && <div className="room-app-toolbar-actions room-app-notepad-file-actions">{fileActions}</div>}
  </div>;
};
