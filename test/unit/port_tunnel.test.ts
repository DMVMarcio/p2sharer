import test from 'node:test';
import assert from 'node:assert/strict';
import { createTunnelRules, TUNNEL_RULES_KEY, type TunnelRule } from '../../src/apps/tunnel_rules.ts';
import { TunnelModel, type TunnelNative, type TunnelForward } from '../../src/apps/tunnel_model.ts';

const rule: TunnelRule = { id: '11111111-1111-4111-8111-111111111111', name: 'Local service', port: 12345, protocol: 'tcp' };
const generation = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let forwards: TunnelForward[] = [];
  const native: TunnelNative = {
    available: true, listen: async () => () => {},
    call: async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === 'connect_port_tunnel') {
        const exported = args.export as TunnelRule;
        const forward = { id: crypto.randomUUID(), peer: args.peer as string, tunnel: exported.id, port: (args.port as number) || 23456, protocol: exported.protocol };
        forwards.push(forward); return forward as T;
      }
      if (command === 'disconnect_port_tunnel') forwards = forwards.filter((f) => f.id !== args.id);
      if (command === 'stop_port_tunnels') forwards = [];
      return (command === 'get_port_tunnel_status' ? { counters: {}, forwards: [...forwards] } : undefined) as T;
    },
  };
  const sent: { payload: unknown; target?: string }[] = [];
  const model = new TunnelModel({ localActor: 'alice', instanceId: crypto.randomUUID(), changed: () => {},
    emit: (payload) => { sent.push({ payload }); }, send: async (payload, target) => { sent.push({ payload, target }); } }, native, storage);
  return { model, native, calls, sent, storage, memory, settle: () => new Promise<void>((resolve) => setImmediate(resolve)) };
}

test('published proxies connect automatically on a free port and revoke on owner deactivation', async () => {
  const f = fixture(); f.model.setParticipants(['alice', 'bob']); await f.model.save(rule);
  const advertisement = { type: 'advertise', revision: 1, exports: [{ ...rule, generation, enabled: true }] };
  f.model.apply(advertisement, 'bob', false);
  await f.settle();
  assert.equal(f.model.status.forwards.length, 1);
  assert.equal(f.calls.find((c) => c.command === 'connect_port_tunnel')!.args.port, 0);
  f.model.apply(advertisement, 'bob', false); await f.settle();
  assert.equal(f.calls.filter((c) => c.command === 'connect_port_tunnel').length, 1);
  f.model.apply({ ...advertisement, revision: 2, exports: [{ ...rule, generation, enabled: false }] }, 'bob', false);
  await f.settle();
  assert.equal(f.model.status.forwards.length, 0);
  f.model.destroy();
});

test('saved tunnel rules never restore activation and storage failures do not report success', async () => {
  const f = fixture();
  f.memory.set(TUNNEL_RULES_KEY, JSON.stringify([{ ...rule, enabled: true, generation }]));
  assert.deepEqual(createTunnelRules(f.storage).list(), [rule]);
  f.model.setParticipants(['alice', 'bob']);
  await f.model.save(rule);
  await f.model.toggle(rule.id, true);
  assert.equal(f.model.active.size, 1);
  f.model.destroy();
  const restored = new TunnelModel({ localActor: 'alice', changed: () => {}, emit: () => {} }, f.native, f.storage);
  assert.deepEqual(restored.rules, [rule]);
  assert.equal(restored.active.size, 0);
  restored.destroy();
  const failure = new TunnelModel({ localActor: 'alice', changed: () => {}, emit: () => {} }, f.native,
    { getItem: () => null, setItem: () => { throw new Error('quota'); } });
  await assert.rejects(failure.save(rule), /quota/);
  assert.deepEqual(failure.rules, []);
  failure.destroy();
});

test('only joined direct actors advertise themselves; snapshots cannot execute socket packets', async () => {
  const f = fixture();
  f.model.setParticipants(['alice', 'bob', 'charlie']);
  await f.model.save(rule);
  const advertisement = { type: 'advertise', revision: 1, exports: [{ ...rule, generation, enabled: true }] };
  f.model.apply(advertisement, 'mallory', false);
  assert.equal(f.model.remote.size, 0);
  f.model.apply(advertisement, 'bob', true);
  assert.deepEqual(f.model.remote.get('bob'), advertisement.exports);
  f.model.apply({ type: 'advertise', revision: 0, exports: [] }, 'bob', false);
  assert.equal(f.model.remote.get('bob')?.length, 1);
  f.model.apply({ type: 'advertise', revision: 2, exports: [] }, 'charlie', false);
  assert.equal(f.model.remote.get('bob')?.length, 1);
  const packet = { type: 'wire', packet: { kind: 'open', session: '33333333333333333333333333333333' } };
  f.model.apply(packet, 'bob', true);
  assert.equal(f.calls.filter((c) => c.command === 'receive_port_tunnel').length, 0);
  f.model.apply(packet, 'bob', false);
  assert.equal(f.calls.filter((c) => c.command === 'receive_port_tunnel').length, 1);
  f.model.setParticipants(['alice', 'charlie']);
  f.model.apply(packet, 'bob', false);
  assert.equal(f.model.remote.has('bob'), false);
  assert.equal(f.calls.filter((c) => c.command === 'receive_port_tunnel').length, 1);
  f.model.destroy();
});

test('editing and leaving revoke enabled exports; rejoining requires manual activation', async () => {
  const f = fixture();
  f.model.setParticipants(['alice', 'bob']);
  await f.model.save(rule);
  await f.model.toggle(rule.id, true);
  await f.model.save({ ...rule, port: 12346 });
  assert.equal(f.model.active.size, 0);
  await f.model.toggle(rule.id, true);
  f.model.setParticipants(['bob']);
  assert.equal(f.model.active.size, 0);
  f.model.setParticipants(['alice', 'bob']);
  await f.model.save({ ...rule, port: 12346 });
  const config = f.calls.filter((c) => c.command === 'configure_port_tunnels').at(-1);
  assert.deepEqual(config?.args.exports, []);
  assert.deepEqual(config?.args.peers, ['bob']);
  assert.equal(f.model.active.size, 0);
  f.model.destroy();
});

test('native configuration failures close the scope and cannot restore an enabled flag', async () => {
  const f = fixture();
  f.model.setParticipants(['alice', 'bob']);
  await f.model.save(rule);
  const original = f.native.call;
  f.native.call = async <T>(command: string, args: Record<string, unknown>) => {
    if (command === 'configure_port_tunnels') throw new Error('native unavailable');
    return original<T>(command, args);
  };
  await assert.rejects(f.model.toggle(rule.id, true), /native unavailable/);
  assert.equal(f.model.active.size, 0);
  assert.ok(f.calls.some((c) => c.command === 'stop_port_tunnels'));
  f.model.destroy();
});

test('disabled rules are visible without granting access and client port choices persist without activation', async () => {
  const f = fixture();
  f.model.setParticipants(['alice', 'bob']);
  await f.model.save(rule);
  assert.deepEqual((f.model.snapshot() as { exports: unknown[] }).exports, [{ ...rule, enabled: false,
    generation: '00000000-0000-0000-0000-000000000000' }]);
  f.model.apply({ type: 'advertise', revision: 1, exports: [{ ...rule, generation, enabled: false }] }, 'bob', false);
  await assert.rejects(f.model.connect('bob', rule.id, 12346), /unavailable/);
  assert.equal(f.calls.filter((c) => c.command === 'connect_port_tunnel').length, 0);
  const store = createTunnelRules(f.storage);
  store.saveLocalPort(rule.id, 12346);
  assert.equal(f.model.localPort(rule.id, rule.port), 12346);
  const restored = createTunnelRules(f.storage);
  assert.equal(restored.localPort(rule.id, rule.port), 12346);
  assert.equal(f.model.status.forwards.length, 0);
  f.model.destroy();
});

test('concurrent activity instances retain shared saved definitions and revoke an edited export', async () => {
  const f = fixture();
  const other = new TunnelModel({ localActor: 'alice', instanceId: crypto.randomUUID(), changed: () => {}, emit: () => {} }, f.native, f.storage);
  f.model.setParticipants(['alice', 'bob']); other.setParticipants(['alice', 'bob']);
  await f.model.save(rule);
  assert.deepEqual(other.rules, [rule]);
  await other.toggle(rule.id, true);
  await f.model.save({ ...rule, port: 12347 });
  assert.equal(other.active.size, 0);
  assert.equal(other.rules[0].port, 12347);
  const second = { ...rule, id: '44444444-4444-4444-8444-444444444444', name: 'Another service' };
  await other.save(second);
  assert.equal(f.model.rules.length, 2);
  assert.equal(createTunnelRules(f.storage).list().length, 2);
  other.destroy(); f.model.destroy();
});

test('queued activation cannot carry consent across leaving and rejoining', async () => {
  const f = fixture(); f.model.setParticipants(['alice', 'bob']); await f.model.save(rule);
  const enabling = f.model.toggle(rule.id, true);
  f.model.setParticipants(['bob']); f.model.setParticipants(['alice', 'bob']);
  await assert.rejects(enabling, /unavailable/);
  assert.equal(f.model.active.size, 0);
  f.model.destroy();
});
