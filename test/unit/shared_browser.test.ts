import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserControlLease, browserUrl, browserPointerPosition, validBrowserCommand, validBrowserState, validBrowserDialog, type BrowserCommand } from '../../src/apps/browser_protocol.ts';
import { BrowserModel, type BrowserNative } from '../../src/apps/browser_model.ts';

const move = (x = 100): BrowserCommand => ({ kind: 'mouse', event: 'mouseMoved', x, y: 100, button: 'none', buttons: 0, delta_x: 0, delta_y: 0, modifiers: 0, clicks: 0 });
const state = { tabs: [{ id: 1, title: 'Example', url: 'https://example.com/' }], active: 1, temporary: false };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('control lease holds gestures, renews typing, grants host preemption and expires lost input', () => {
  const lease = new BrowserControlLease('host');
  lease.update('alice', move(), 100);
  assert.equal(lease.accepts('bob', 1099), false);
  assert.equal(lease.accepts('bob', 1100), true);
  lease.update('alice', { ...move(), event: 'mousePressed', button: 'left', buttons: 1 } as BrowserCommand, 200);
  assert.equal(lease.accepts('bob', 2000), false);
  assert.equal(lease.accepts('host', 201), true);
  lease.update('alice', { ...move(), event: 'mouseReleased' } as BrowserCommand, 300);
  assert.equal(lease.accepts('bob', 1300), true);
  lease.update('alice', { kind: 'key', event: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8, virtual_key: 16 }, 400);
  assert.equal(lease.accepts('bob', 1400), false);
  assert.equal(lease.accepts('bob', 10400), true);
  lease.clear(); assert.equal(lease.keys.size, 0); assert.equal(lease.owner, '');
});

test('browser input and snapshots reject unsafe URLs, oversized data and invalid coordinates', () => {
  assert.equal(browserUrl('example.com'), 'https://example.com/');
  assert.equal(browserUrl('a shared search'), 'https://www.google.com/search?q=a%20shared%20search');
  for (const url of ['javascript:alert(1)', 'file:///test', 'http://tauri.localhost', 'http://localhost:1420']) assert.equal(browserUrl(url), null);
  const credentials = new URL('https://example.com'); credentials.username = 'fixture-user'; credentials.password = 'fixture-password';
  assert.equal(browserUrl(credentials.href), null);
  assert.equal(validBrowserCommand(move()), true);
  assert.equal(validBrowserCommand({ ...move(), x: Infinity }), false);
  assert.equal(validBrowserCommand({ kind: 'text', text: 'x'.repeat(4097) }), false);
  assert.equal(validBrowserCommand({ kind: 'evaluate', script: 'test' }), false);
  assert.equal(validBrowserState(state), true);
  assert.equal(validBrowserState({ ...state, active: 2 }), false);
  assert.equal(validBrowserState({ ...state, tabs: [state.tabs[0], state.tabs[0]] }), false);
});

test('contained browser coordinates remain correct in full screen and letterboxed cards', () => {
  assert.deepEqual(browserPointerPosition(500, 500, {left:0, top:0, width:1000, height:1000}), {x:640,y:360});
  assert.deepEqual(browserPointerPosition(960, 540, {left:0, top:0, width:1920, height:1080}), {x:640,y:360});
  assert.equal(browserPointerPosition(500, 100, {left:0, top:0, width:1000, height:1000}), null);
  assert.deepEqual(browserPointerPosition(500, 100, {left:0, top:0, width:1000, height:1000}, true), {x:640,y:0});
  assert.equal(browserPointerPosition(0, 0, {left:0, top:0, width:0, height:0}), null);
});

function fixture(local = 'host', onCall?: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const sent: { payload: unknown; target?: string }[] = [];
  const native: BrowserNative = { call: async <T>(command: string, args: Record<string, unknown>) => {
    calls.push({ command, args }); return (await onCall?.(command, args) ?? null) as T;
  } };
  const model = new BrowserModel({ localActor: local, createdBy: 'host', instanceId: crypto.randomUUID(), changed() {}, emit() {},
    send: async (payload, target) => { sent.push({ payload, target }); } }, native, false);
  model.setParticipants(['host', 'alice', 'bob']); model.state = structuredClone(state); model.running = true;
  return { model, calls, sent };
}
test('creator owns browser state; remote snapshots and commands cannot impersonate its host', async () => {
  const { model, calls } = fixture('alice');
  model.apply({ type: 'state', state, revision: 10, running: true, paused: false, controller: '' }, 'bob', false);
  assert.equal(model.revision, 0);
  model.apply({ type: 'state', state, revision: 10, running: true, paused: false, controller: '' }, 'host', true);
  assert.equal(model.revision, 10);
  model.apply({ type: 'state', state: { ...state, active: 2 }, revision: 11, running: true, paused: false, controller: '' }, 'host', false);
  assert.equal(model.revision, 10);
  model.apply({ type: 'command', command: move(), sequence: 1, tab: 1 }, 'bob', false);
  await settle(); assert.equal(calls.length, 0); model.destroy();
});
test('only joined live actors control the native browser; replay, snapshots and stale tabs cannot execute', async () => {
  const { model, calls } = fixture();
  const request = { type: 'command', command: move(), sequence: 1, tab: 1 };
  model.apply(request, 'outsider', false);
  model.apply(request, 'alice', true);
  model.apply({ ...request, tab: 2 }, 'bob', false);
  await settle(); assert.equal(calls.length, 0);
  model.apply(request, 'alice', false); await settle(); assert.equal(calls.length, 1);
  model.apply(request, 'alice', false); await settle(); assert.equal(calls.length, 1);
  model.apply({ ...request, sequence: 2 }, 'bob', false); await settle(); assert.equal(calls.length, 1);
  model.setParticipants(['host', 'bob']); await settle();
  assert.ok(calls.some(call => (call.args.command as BrowserCommand).kind === 'release'));
  model.destroy();
});
test('host preempts held keys safely and pause prevents remote actions', async () => {
  const { model, calls } = fixture();
  const key: BrowserCommand = { kind: 'key', event: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8, virtual_key: 16 };
  model.apply({ type: 'command', command: key, sequence: 1, tab: 1 }, 'alice', false); await settle();
  model.command(move(120)); await settle();
  assert.equal(model.controller, 'host');
  assert.ok(calls.some(call => (call.args.command as Extract<BrowserCommand, {kind:'key'}>).event === 'keyUp'));
  model.togglePause(); await settle(); const previous = calls.length;
  model.apply({ type: 'command', command: move(), sequence: 2, tab: 1 }, 'alice', false); await settle();
  assert.equal(calls.length, previous); model.destroy();
});
test('leaving the browser invalidates queued commands and removes remote media and control state', async () => {
  const { model, calls } = fixture();
  model.apply({ type: 'command', command: move(), sequence: 1, tab: 1 }, 'alice', false);
  model.setParticipants(['alice']); await settle();
  assert.equal(model.running, false); assert.equal(model.controller, ''); assert.equal(calls.length, 0);
  model.destroy();
});

test('commands queued before a peer leaves cannot execute after it rejoins', async () => {
  const { model, calls } = fixture();
  model.apply({ type: 'command', command: move(), sequence: 1, tab: 1 }, 'alice', false);
  model.setParticipants(['host', 'bob']);
  model.setParticipants(['host', 'alice', 'bob']);
  await settle(); assert.equal(calls.length, 0); model.destroy();
});

test('a returning host remains offline for control until it starts the browser again', () => {
  const { model } = fixture('alice');
  model.setParticipants(['alice', 'bob']);
  assert.equal(model.running, false); assert.equal(model.canControl, false);
  model.setParticipants(['host', 'alice', 'bob']);
  assert.equal(model.running, false); assert.equal(model.canControl, false);
  model.destroy();
});

test('a native response from a retired browser session cannot replace its restarted state', async () => {
  let complete!: (state: unknown) => void;
  const response = new Promise(resolve => { complete = resolve; });
  const { model } = fixture('host', async command => command === 'control_shared_browser' ? response : null);
  model.apply({type:'command',command:{kind:'reload'},sequence:1,tab:1},'alice',false); await settle();
  model.setParticipants(['alice']); model.setParticipants(['host','alice']);
  model.running = true; model.state = {...state, serial:1};
  complete({...state, active:2, tabs:[{id:2,url:'https://example.com/previous',title:'Previous session'}], serial:100});
  await settle(); assert.equal(model.state.active,1); assert.equal(model.state.serial,1); model.destroy();
});

test('script dialog answers require live participation and unblock a paused native input queue', async () => {
  let unblock!: () => void;
  const paused = new Promise<void>(resolve => { unblock = resolve; });
  const { model, calls } = fixture('host', async (command, args) => {
    if (command === 'control_shared_browser' && (args.command as BrowserCommand).kind === 'mouse') await paused;
    if (command === 'resolve_browser_dialog') unblock();
  });
  const dialog = { id: 'a'.repeat(32), tab: 1, kind: 'prompt' as const, message: 'Website prompt', defaultText: '' };
  assert.equal(validBrowserDialog(dialog), true);
  assert.equal(validBrowserDialog({ ...dialog, message: 'x'.repeat(8193) }), false);
  model.apply({ type: 'command', command: move(), sequence: 1, tab: 1 }, 'alice', false); await settle();
  model.dialog = dialog;
  const answer = { type: 'dialog-answer', id: dialog.id, accept: true, text: 'Shared response', sequence: 2 };
  model.apply(answer, 'outsider', false); model.apply(answer, 'alice', true);
  model.apply({ ...answer, id: 'b'.repeat(32) }, 'alice', false);
  assert.equal(calls.filter(c => c.command === 'resolve_browser_dialog').length, 0);
  model.apply(answer, 'alice', false); model.apply({ ...answer, sequence: 3 }, 'alice', false);
  await settle();
  assert.equal(calls.filter(c => c.command === 'resolve_browser_dialog').length, 1);
  assert.equal(model.dialog, null); assert.equal(model.controller, ''); model.destroy();
});
