import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const probe = readFileSync(new URL('../../src-tauri/src/browser_selection.js', import.meta.url), 'utf8');

test('browser selection reads page ranges, focused fields and shadow inputs without reading the OS clipboard', () => {
  const dom = new JSDOM('<p>Shared page text</p><input value="Selected input"><textarea>Other tab paste</textarea><input type="password" value="private"><div id="shadow"></div><iframe></iframe>', { runScripts: 'outside-only' });
  const { window } = dom;
  const read = () => JSON.parse(JSON.stringify(window.eval(probe)));
  try {
    const range = window.document.createRange(); range.selectNodeContents(window.document.querySelector('p'));
    window.getSelection().addRange(range);
    assert.equal(read().text, 'Shared page text');
    const input = window.document.querySelector('input'); input.focus(); input.setSelectionRange(0, 8);
    assert.equal(read().text, 'Selected');
    const textarea = window.document.querySelector('textarea'); textarea.focus(); textarea.setSelectionRange(6, 9);
    assert.equal(read().text, 'tab');
    const root = window.document.getElementById('shadow').attachShadow({ mode: 'open' });
    const shadowInput = window.document.createElement('input'); root.append(shadowInput);
    shadowInput.value = 'Shadow field'; shadowInput.focus(); shadowInput.select();
    assert.equal(read().text, 'Shadow field');
    const password = window.document.querySelector('[type=password]'); password.focus(); password.select();
    assert.equal(read().text, '');
    window.document.querySelector('iframe').focus(); assert.equal(read().frame, true);
    input.value = 'a'.repeat(70000); input.focus(); input.select();
    assert.equal(read().text.length, 65536);
  } finally { window.close(); }
});
