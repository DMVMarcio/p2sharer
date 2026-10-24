import { Extension, type Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { codeLanguage } from '../../core/code_highlighting';

type LineAction = 'indent' | 'outdent' | 'duplicateUp' | 'duplicateDown' | 'up' | 'down' | 'comment';

function indentNoteText(editor: Editor, outdent = false): boolean {
  const { state } = editor;
  if (!outdent && state.selection.empty) return editor.commands.insertContent('\t');
  const edits: { from: number; to: number; text: string }[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
    if (!node.isTextblock) return;
    const leading = node.textContent.match(/^(?:\t| {1,2})/);
    if (!outdent || leading) edits.push({ from: position + 1, to: position + 1 + (outdent ? leading![0].length : 0), text: outdent ? '' : '\t' });
    return false;
  });
  const tr = state.tr;
  for (const edit of edits.reverse()) tr.insertText(edit.text, edit.from, edit.to);
  tr.setSelection(state.selection.map(tr.doc, tr.mapping));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function editCodeLines(editor: Editor, action: LineAction): boolean {
  if (!editor.isEditable) return false;
  const { state } = editor;
  const { $from, $to, anchor, head, empty } = state.selection;
  if ($from.parent.type.name !== 'codeBlock' || !$from.sameParent($to)) return false;
  const text = $from.parent.textContent;
  const start = $from.start();
  const from = $from.parentOffset;
  const to = $to.parentOffset;
  const lineStart = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
  // A selection ending at the start of a line does not include that line.
  const endOffset = !empty && to > from && text[to - 1] === '\n' ? to - 1 : to;
  const nextBreak = text.indexOf('\n', endOffset);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  let replacement = '';
  let replaceFrom = lineStart;
  let replaceTo = lineEnd;
  let nextAnchor = anchor - start;
  let nextHead = head - start;
  if (action === 'indent' && empty) return editor.commands.insertContent('  ');
  if (action === 'indent' || action === 'outdent' || action === 'comment') {
    const language = codeLanguage($from.parent.attrs.language);
    const prefix = ['python', 'ruby', 'bash', 'shell', 'perl', 'r', 'yaml', 'makefile', 'ini'].includes(language) ? '#'
      : ['sql', 'lua'].includes(language) ? '--'
        : ['javascript', 'typescript', 'c', 'cpp', 'csharp', 'java', 'kotlin', 'go', 'rust', 'swift', 'php', 'objectivec', 'arduino'].includes(language) ? '//' : null;
    if (action === 'comment' && !prefix) return false;
    const uncomment = action === 'comment' && lines.filter(line => line.trim()).every(line => line.trimStart().startsWith(prefix!));
    let offset = lineStart;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const leading = line.match(/^[\t ]*/)?.[0].length ?? 0;
      let at = offset;
      let removed = 0;
      let inserted = '';
      if (action === 'indent') inserted = '  ';
      else if (action === 'outdent') removed = line.startsWith('\t') ? 1 : Math.min(2, line.match(/^ */)![0].length);
      else if (line.trim()) {
        at += leading;
        if (uncomment) removed = prefix!.length + (line[leading + prefix!.length] === ' ' ? 1 : 0);
        else inserted = `${prefix} `;
      }
      const map = (position: number) => position < at ? position : position <= at + removed ? at + inserted.length : position + inserted.length - removed;
      // Map original endpoints through each edit using original coordinates.
      const adjust = (position: number) => map(position) - position;
      nextAnchor += adjust(anchor - start);
      nextHead += adjust(head - start);
      lines[index] = line.slice(0, at - offset) + inserted + line.slice(at - offset + removed);
      offset += line.length + 1;
    }
    replacement = lines.join('\n');
  } else {
    const selected = lines.join('\n');
    let shift = 0;
    if (action === 'duplicateUp' || action === 'duplicateDown') {
      replacement = `${selected}\n${selected}`;
      shift = action === 'duplicateDown' ? selected.length + 1 : 0;
    } else if (action === 'up') {
      if (lineStart === 0) return true;
      replaceFrom = lineStart < 2 ? 0 : text.lastIndexOf('\n', lineStart - 2) + 1;
      const previous = text.slice(replaceFrom, lineStart - 1);
      replacement = `${selected}\n${previous}`;
      shift = -(previous.length + 1);
    } else {
      if (lineEnd === text.length) return true;
      const followingBreak = text.indexOf('\n', lineEnd + 1);
      replaceTo = followingBreak < 0 ? text.length : followingBreak;
      const following = text.slice(lineEnd + 1, replaceTo);
      replacement = `${following}\n${selected}`;
      shift = following.length + 1;
    }
    nextAnchor += shift;
    nextHead += shift;
  }
  const tr = state.tr.insertText(replacement, start + replaceFrom, start + replaceTo);
  tr.setSelection(TextSelection.create(tr.doc, start + nextAnchor, start + nextHead));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const CodeEditing = Extension.create<{ plainTextTab: boolean }>({
  name: 'codeEditing',
  priority: 1100,
  addOptions() { return { plainTextTab: false }; },
  addKeyboardShortcuts() {
    const run = (action: LineAction) => () => editCodeLines(this.editor, action);
    return {
      Tab: () => {
        if (editCodeLines(this.editor, 'indent')) return true;
        if (!this.options.plainTextTab || !this.editor.isEditable || this.editor.isActive('table')) return false;
        if (this.editor.isActive('listItem')) return this.editor.commands.sinkListItem('listItem');
        return indentNoteText(this.editor);
      },
      'Shift-Tab': () => {
        if (editCodeLines(this.editor, 'outdent')) return true;
        if (!this.options.plainTextTab || !this.editor.isEditable || this.editor.isActive('table')) return false;
        if (this.editor.isActive('listItem')) return this.editor.commands.liftListItem('listItem');
        return indentNoteText(this.editor, true);
      },
      'Mod-]': run('indent'), 'Mod-[': run('outdent'),
      'Alt-ArrowUp': run('up'), 'Alt-ArrowDown': run('down'),
      'Alt-Shift-ArrowUp': run('duplicateUp'), 'Alt-Shift-ArrowDown': run('duplicateDown'),
      'Mod-/': run('comment'),
      Enter: () => {
        const { $from, empty } = this.editor.state.selection;
        if (!this.editor.isEditable || !empty || $from.parent.type.name !== 'codeBlock') return false;
        const before = $from.parent.textContent.slice(0, $from.parentOffset).split('\n').pop()!;
        if (!before.trim()) return false; // Keep the standard triple-Enter exit.
        const indent = before.match(/^[\t ]*/)?.[0] ?? '';
        return this.editor.commands.insertContent(`\n${indent}${/[{[(]\s*$/.test(before) ? '  ' : ''}`);
      },
    };
  },
});
