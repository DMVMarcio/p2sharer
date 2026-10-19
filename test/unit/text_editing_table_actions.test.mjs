import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent']) {
  globalThis[key] = dom.window[key];
}

test('text editing actions provide table submenus and row/column mutations when cursor is inside a table', async () => {
  const result = await build({
    stdin: {
      contents: `
        export { getTextEditingActions } from './src/components/common/text_editing_actions.tsx';
      `,
      resolveDir: process.cwd(),
      sourcefile: 'text_editing_table_entry.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    target: 'esnext',
  });

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  const { getTextEditingActions } = await import(moduleUrl);

  // 1. Regular session outside of table
  const nonTableSession = {
    source: document.createElement('textarea'),
    selectedText: 'hello',
    editable: true,
    canCopy: true,
    canUndo: true,
    canRedo: false,
    hasText: true,
    restore: () => {},
    insertText: () => {},
    deleteSelection: () => {},
    undo: () => {},
    redo: () => {},
    selectAll: () => {},
  };
  const standardActions = getTextEditingActions(nonTableSession);
  assert.equal(standardActions.some(a => a.id.startsWith('table-')), false);
  assert.deepEqual(standardActions.map(a => a.id), ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'select-all']);

  // 2. Table session inside editable TipTap editor
  const recorded = [];
  let restored = false;
  const mockEditor = {
    isActive: (name) => name === 'table',
    chain: () => {
      const builder = {
        focus: () => builder,
        addRowBefore: () => { recorded.push('addRowBefore'); return builder; },
        addRowAfter: () => { recorded.push('addRowAfter'); return builder; },
        addColumnBefore: () => { recorded.push('addColumnBefore'); return builder; },
        addColumnAfter: () => { recorded.push('addColumnAfter'); return builder; },
        deleteRow: () => { recorded.push('deleteRow'); return builder; },
        deleteColumn: () => { recorded.push('deleteColumn'); return builder; },
        deleteTable: () => { recorded.push('deleteTable'); return builder; },
        run: () => { recorded.push('run'); return true; },
      };
      return builder;
    },
  };

  const tableSession = {
    ...nonTableSession,
    editor: mockEditor,
    restore: () => { restored = true; },
  };

  const tableActions = getTextEditingActions(tableSession);
  const actionIds = tableActions.map(a => a.id);
  assert.ok(actionIds.includes('table-add-row'));
  assert.ok(actionIds.includes('table-add-col'));
  assert.ok(actionIds.includes('table-delete-row'));
  assert.ok(actionIds.includes('table-delete-col'));
  assert.ok(actionIds.includes('table-delete'));

  // Test row submenu
  const addRowAction = tableActions.find(a => a.id === 'table-add-row');
  assert.ok(addRowAction.submenu && addRowAction.submenu.length === 2);
  assert.equal(addRowAction.submenu[0].id, 'table-add-row-before');
  assert.equal(addRowAction.submenu[1].id, 'table-add-row-after');

  restored = false;
  recorded.length = 0;
  addRowAction.submenu[0].onSelect();
  assert.equal(restored, true);
  assert.deepEqual(recorded, ['addRowBefore', 'run']);

  restored = false;
  recorded.length = 0;
  addRowAction.submenu[1].onSelect();
  assert.equal(restored, true);
  assert.deepEqual(recorded, ['addRowAfter', 'run']);

  // Test column submenu
  const addColAction = tableActions.find(a => a.id === 'table-add-col');
  assert.ok(addColAction.submenu && addColAction.submenu.length === 2);
  assert.equal(addColAction.submenu[0].id, 'table-add-col-before');
  assert.equal(addColAction.submenu[1].id, 'table-add-col-after');

  restored = false;
  recorded.length = 0;
  addColAction.submenu[0].onSelect();
  assert.equal(restored, true);
  assert.deepEqual(recorded, ['addColumnBefore', 'run']);

  restored = false;
  recorded.length = 0;
  addColAction.submenu[1].onSelect();
  assert.equal(restored, true);
  assert.deepEqual(recorded, ['addColumnAfter', 'run']);

  // Test delete row
  const deleteRowAction = tableActions.find(a => a.id === 'table-delete-row');
  restored = false;
  recorded.length = 0;
  deleteRowAction.onSelect();
  assert.equal(restored, true);
  assert.deepEqual(recorded, ['deleteRow', 'run']);

  // Test delete column
  const deleteColAction = tableActions.find(a => a.id === 'table-delete-col');
  restored = false;
  recorded.length = 0;
  deleteColAction.onSelect();
  assert.equal(restored, true);
  assert.deepEqual(recorded, ['deleteColumn', 'run']);

  // Test delete table
  const deleteTableAction = tableActions.find(a => a.id === 'table-delete');
  assert.equal(deleteTableAction.danger, true);
  restored = false;
  recorded.length = 0;
  deleteTableAction.onSelect();
  assert.equal(restored, true);
  assert.deepEqual(recorded, ['deleteTable', 'run']);
});
