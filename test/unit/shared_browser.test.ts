import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserControlLease, browserUrl, browserPointerPosition, validBrowserCommand, validBrowserState, validBrowserDialog, type BrowserCommand } from '../../src/apps/browser_protocol.ts';
import { BrowserModel, type BrowserNative } from '../../src/apps/browser_model.ts';
import { toastManager } from '../../src/hooks/useToast.ts';

const move = (x = 100): BrowserCommand => ({ kind: 'mouse', event: 'mouseMoved', x, y: 100, button: 'none', buttons: 0, delta_x: 0, delta_y: 0, modifiers: 0, clicks: 0 });
const state = { tabs: [{ id: 1, title: 'Example', url: 'https://example.com/' }], active: 1, temporary: false };
const hostTerm = '00000000-0000-4000-8000-000000000001';
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
  const iconState = (favicon: string) => ({ ...state, tabs: [{ ...state.tabs[0], favicon }] });
  assert.equal(validBrowserState(iconState('data:image/png;base64,iVBORw0KGgo=')), true);
  for (const icon of ['https://example.com/favicon.ico', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,' + 'A'.repeat(8192)]) {
    assert.equal(validBrowserState(iconState(icon)), false, 'room icons must be bounded PNGs supplied by the host');
  }
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
  model.setParticipants(['host', 'alice', 'bob']);
  model.apply({ type: 'ownership', host: 'host', term: hostTerm, version: 2 }, 'alice', false);
  model.state = structuredClone(state); model.running = true; sent.length = 0;
  return { model, calls, sent };
}

test('page context is accepted only from the live host session with safe bounded data', () => {
  const { model } = fixture('alice');
  const menu = { tab: 1, x: 50, y: 60, link: 'https://example.com/', source: '', selection: 'Selected', editable: false };
  const packet = { type: 'context-menu', menu, session: '' };
  try {
    for (const [actor, snapshot, data] of [
      ['bob', false, packet], ['host', true, packet], ['host', false, { ...packet, session: crypto.randomUUID() }],
      ['host', false, { ...packet, menu: { ...menu, tab: 2 } }], ['host', false, { ...packet, menu: { ...menu, link: 'file:///private' } }],
      ['host', false, { ...packet, menu: { ...menu, x: Infinity } }], ['host', false, { ...packet, menu: { ...menu, selection: 'x'.repeat(8193) } }],
    ] as [string, boolean, unknown][]) { model.apply(data, actor, snapshot); assert.equal(model.contextMenu, null); }
    model.apply(packet, 'host', false); assert.equal(model.contextMenu?.selection, 'Selected');
    model.destroy(); assert.equal(model.contextMenu, null);
  } finally { model.destroy(); }
});

test('browser failures use dismissible expiring notifications and coalesce repeated input failures', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let notifications: { id: string; type: string }[] = [];
  const unsubscribe = toastManager.subscribe(items => { notifications = items; });
  const { model } = fixture('host', async () => { throw new Error('Browser operation failed'); });
  try {
    model.command({ kind: 'reload' }); await settle();
    assert.equal(notifications.length, 1); assert.equal(notifications[0].type, 'error');
    model.command({ kind: 'reload' }); await settle(); assert.equal(notifications.length, 1);
    context.mock.timers.tick(5001); assert.equal(notifications.length, 0);
  } finally { notifications.forEach(item => toastManager.remove(item.id)); unsubscribe(); model.destroy(); context.mock.timers.reset(); }
});

test('host speaker volume stays local, bypasses shared controls and rejects viewer changes', async () => {
  const host = fixture(); const viewer = fixture('alice');
  try {
    const before = structuredClone(host.model.snapshot());
    await host.model.setLocalVolume(0.25, false);
    await host.model.setLocalVolume(0.25, true);
    assert.deepEqual(host.calls.map(call => [call.command, call.args.volume, call.args.muted]), [
      ['set_shared_browser_volume', 0.25, false], ['set_shared_browser_volume', 0.25, true],
    ]);
    assert.deepEqual(host.model.snapshot(), before);
    assert.equal(host.sent.length, 0);
    await viewer.model.setLocalVolume(0, true);
    assert.equal(viewer.calls.length, 0);
    for (const value of [-1, 2, NaN, Infinity]) await host.model.setLocalVolume(value, false);
    host.model.running = false; await host.model.setLocalVolume(1, false);
    assert.equal(host.calls.length, 2);
  } finally { host.model.destroy(); viewer.model.destroy(); }
});

test('leaving the viewport immediately frees control and stale queued motion cannot reclaim it', async () => {
  let unblock = () => {}; let blocked = false;
  const { model, calls } = fixture('host', async (command, args) => {
    if (command === 'control_shared_browser' && (args.command as BrowserCommand).kind === 'mouse' && !blocked) {
      blocked = true; await new Promise<void>(resolve => { unblock = resolve; });
    }
    return null;
  });
  const input = (actor: string, sequence: number, command: BrowserCommand) => model.apply({ type: 'command', sequence, tab: 1, command }, actor, false);
  try {
    input('alice', 1, move(10)); await settle();
    input('alice', 2, move(20)); input('alice', 3, { kind: 'cursor-leave' });
    assert.equal(model.pointer, null); assert.equal(model.controller, '');
    input('bob', 1, move(30)); unblock(); await settle(); await settle();
    assert.equal(model.controller, 'bob'); assert.equal(model.pointer?.x, 30);
    assert.equal(calls.some(call => (call.args.command as { x?: number })?.x === 20), false);
  } finally { unblock(); model.destroy(); }
});

test('only accepted navigation produces activity, without replaying snapshots or pointer and keyboard input', async () => {
  const host = fixture(); const peer = fixture('bob');
  try {
    host.model.command(move(10)); await settle(); assert.equal(host.model.activity, null);
    host.model.command({ kind: 'reload' }); await settle();
    assert.equal(host.model.activity?.action, 'reload');
    const packet = host.sent.find(item => (item.payload as { type?: string }).type === 'activity')!.payload;
    peer.model.apply(packet, 'host', true); assert.equal(peer.model.activity, null);
    peer.model.apply(packet, 'alice', false); assert.equal(peer.model.activity, null);
    peer.model.apply(packet, 'host', false); assert.equal(peer.model.activity?.action, 'reload');
    const current = peer.model.activity;
    peer.model.apply(packet, 'host', false); assert.equal(peer.model.activity, current);
    peer.model.apply({ ...(packet as object), id: 999, action: 'mouse' }, 'host', false); assert.equal(peer.model.activity, current);
    peer.model.apply({ ...(packet as object), id: 999, session: crypto.randomUUID() }, 'host', false); assert.equal(peer.model.activity, current);
  } finally { host.model.destroy(); peer.model.destroy(); }
});

test('busy native input keeps the virtual cursor current and coalesces movement behind click barriers', async () => {
  let unblock: () => void = () => {};
  let blocked = false;
  const { model, calls } = fixture('host', async (command, args) => {
    if (command === 'control_shared_browser' && !blocked) {
      blocked = true; await new Promise<void>(resolve => { unblock = resolve; });
    }
    return null;
  });
  try {
    model.command(move(1)); await settle();
    for (let x = 2; x <= 100; x++) model.command(move(x));
    assert.equal(model.pointer?.x, 100, 'the overlay does not wait for a busy renderer');
    model.command({ ...move(100), event: 'mousePressed', button: 'left', buttons: 1, clicks: 1 } as BrowserCommand);
    for (let x = 101; x <= 200; x++) model.command(move(x));
    unblock(); await settle(); await settle();
    const commands = calls.filter(call => call.command === 'control_shared_browser').map(call => call.args.command as BrowserCommand);
    assert.deepEqual(commands.filter(command => command.kind === 'mouse').map(command => [command.event, command.x]),
      [['mouseMoved', 1], ['mouseMoved', 100], ['mousePressed', 100], ['mouseMoved', 200]]);
    assert.equal(model.pointer?.x, 200);
  } finally { unblock(); model.destroy(); }
});

test('only the accepted browser host can finish its session without removing the room app', async () => {
  const host = fixture(); const peer = fixture('alice');
  try {
    await peer.model.finish(); assert.equal(peer.model.running, true); assert.equal(peer.calls.length, 0);
    await host.model.finish();
    assert.equal(host.model.running, false); assert.equal(host.model.busy, false);
    assert.deepEqual(host.model.state.tabs, []);
    assert.ok(host.calls.some(call => call.command === 'stop_shared_browser'));
    assert.ok(host.sent.some(message => (message.payload as {running?:boolean}).running === false));
    assert.equal(host.model.joined, true);
  } finally { host.model.destroy(); peer.model.destroy(); }
});

test('commands from another browser session cannot execute after the browser restarts', async () => {
  const { model, calls } = fixture();
  const internals = model as unknown as { session: string };
  internals.session = crypto.randomUUID();
  try {
    model.apply({ type: 'command', command: move(), sequence: 1, tab: 1, session: crypto.randomUUID() }, 'alice', false);
    await settle(); assert.equal(calls.length, 0);
    model.apply({ type: 'command', command: move(), sequence: 2, tab: 1, session: internals.session }, 'alice', false);
    await settle(); assert.equal(calls.filter(call => call.command === 'control_shared_browser').length, 1);
  } finally { model.destroy(); }
});
test('the accepted host owns browser state; remote snapshots and commands cannot impersonate it', async () => {
  const { model, calls } = fixture('alice');
  model.apply({ type: 'state', hostTerm, state, revision: 10, running: true, paused: false, controller: '' }, 'bob', false);
  assert.equal(model.revision, 0);
  model.apply({ type: 'state', hostTerm, state, revision: 10, running: true, paused: false, controller: '' }, 'host', true);
  assert.equal(model.revision, 10);
  model.apply({ type: 'state', hostTerm, state: { ...state, active: 2 }, revision: 11, running: true, paused: false, controller: '' }, 'host', false);
  assert.equal(model.revision, 10);
  model.apply({ type: 'command', command: move(), sequence: 1, tab: 1 }, 'bob', false);
  await settle(); assert.equal(calls.length, 0); model.destroy();
});
test('a granted starter becomes native host even when someone else created the room app', async () => {
  const starter = fixture('bob'); const creator = fixture('host'); const term = crypto.randomUUID();
  try {
    for (const { model } of [starter, creator]) model.apply({ type: 'ownership', host: 'bob', term, version: 3 }, 'alice', false);
    assert.equal(starter.model.isHost, true); assert.equal(creator.model.isHost, false);
    starter.model.state = structuredClone(state); starter.model.running = true;
    starter.model.command(move()); await settle();
    assert.ok(starter.calls.some(call => call.command === 'control_shared_browser'));
    await creator.model.finish(); assert.equal(creator.calls.length, 0);
  } finally { starter.model.destroy(); creator.model.destroy(); }
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
