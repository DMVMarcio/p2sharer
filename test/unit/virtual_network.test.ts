import test from 'node:test';
import assert from 'node:assert/strict';
import { TunnelModel, type TunnelNative } from '../../src/apps/tunnel_model.ts';
import { createTunnelRules, isVirtualIp, validTunnelRule, type TunnelRule } from '../../src/apps/tunnel_rules.ts';

const localIP = [10,160,1,1].join('.');
const peerIP = [10,160,1,2].join('.');
const rule: TunnelRule = { id: '11111111-1111-4111-8111-111111111111', name: 'Virtual server', port: 0, protocol: 'any', mode: 'virtual' };
const generation = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const values = new Map<string,string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); } };
  const calls: Array<{ command: string; args: Record<string,unknown> }> = [];
  let event: Parameters<NonNullable<TunnelNative['listenVirtual']>>[0] = () => {};
  let active = false;
  let deny = false;
  const bridge: TunnelNative = {
    available: true, listen: async () => () => {}, listenVirtual: async (handler) => { event = handler; return () => {}; },
    call: async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({command,args});
      if (command === 'get_virtual_network_identity') return { ip: localIP } as T;
      if (command === 'get_port_tunnel_status') return {counters:{},forwards:[]} as T;
      if (command === 'get_virtual_network_status') return {ip:localIP,running:active,active,counters:{}} as T;
      if (command === 'configure_virtual_network') {
        if (deny) throw new Error('Windows consent cancelled');
        const p = args.permissions as {own:unknown[];peers:{grants:unknown[]}[]};
        active = Boolean(p.own.length || p.peers.some((peer) => peer.grants.length));
      }
      if (command === 'stop_virtual_network_scope') active = false;
      return undefined as T;
    },
  };
  const model = new TunnelModel({instanceId:crypto.randomUUID(),localActor:'alice',emit:()=>{},changed:()=>{},send:async()=>{}},bridge,storage);
  return {model,storage,calls,bridge,event:(payload:Parameters<typeof event>[0])=>event(payload),deny:()=>{deny=true;}};
}
test('virtual all-port definitions persist without activation and cannot be downgraded to a proxy', async () => {
  const f = fixture(); f.model.setParticipants(['alice','bob']); await f.model.save(rule);
  assert.equal(f.model.ip,localIP);
  assert.equal(validTunnelRule(rule),true);
  assert.equal(validTunnelRule({...rule,mode:undefined}),false);
  assert.equal(isVirtualIp('127.0.0.1'),false);
  assert.equal(isVirtualIp([10,160,1,255].join('.')),false);
  await f.model.toggle(rule.id,true);
  assert.equal(f.model.active.size,1);
  const proxy = f.calls.filter((c)=>c.command==='configure_port_tunnels').at(-1)!;
  assert.deepEqual(proxy.args.exports,[]);
  const network = f.calls.filter((c)=>c.command==='configure_virtual_network').at(-1)!;
  assert.equal((network.args.permissions as {own:unknown[]}).own.length,1);
  assert.deepEqual(createTunnelRules(f.storage).list(),[rule]);
  f.model.destroy();
  const restored = new TunnelModel({localActor:'alice',emit:()=>{},changed:()=>{}},f.bridge,f.storage);
  assert.equal(restored.active.size,0); assert.equal(restored.networkConnections.size,0); restored.destroy();
});
test('virtual packets require live membership and snapshots cannot inject IP packets', async () => {
  const f = fixture(); f.model.setParticipants(['alice','bob']); await f.model.save(rule);
  const advertisement = {type:'advertise',revision:1,ip:peerIP,exports:[{...rule,generation,enabled:true}]};
  f.model.apply(advertisement,'bob',false);
  await f.model.toggleNetwork('bob',rule.id,true);
  const permissions = f.calls.filter((c)=>c.command==='configure_virtual_network').at(-1)!.args.permissions as {peers:{ip:string;grants:unknown[]}[]};
  assert.equal(permissions.peers[0].ip,peerIP); assert.equal(permissions.peers[0].grants.length,1);
  const packet = {type:'virtual-packet',data:'AAAA'};
  f.model.apply(packet,'bob',true); f.model.apply(packet,'intruder',false);
  assert.equal(f.calls.filter((c)=>c.command==='receive_virtual_network_packet').length,0);
  f.model.apply(packet,'bob',false);
  assert.equal(f.calls.filter((c)=>c.command==='receive_virtual_network_packet').length,1);
  f.model.setParticipants(['alice']); f.model.apply(packet,'bob',false);
  assert.equal(f.model.networkConnections.size,0);
  assert.equal(f.calls.filter((c)=>c.command==='receive_virtual_network_packet').length,1);
  f.model.destroy();
});
test('cancelled elevation and helper failure cannot leave virtual access enabled', async () => {
  const f = fixture(); f.model.setParticipants(['alice','bob']); await f.model.save(rule); f.deny();
  await assert.rejects(f.model.toggle(rule.id,true),/consent cancelled/);
  assert.equal(f.model.active.size,0);
  assert.ok(f.calls.some((c)=>c.command==='stop_virtual_network_scope'));
  f.model.destroy();
  const g = fixture(); g.model.setParticipants(['alice','bob']); await g.model.save(rule); await g.model.toggle(rule.id,true);
  g.event({error:'Virtual network connection was lost'});
  assert.equal(g.model.active.size,0); assert.equal(g.model.networkConnections.size,0); assert.equal(g.model.networkRunning,false);
  g.model.destroy();
});
test('remote revocation and IP changes remove selected virtual connections', async () => {
  const f = fixture(); f.model.setParticipants(['alice','bob']); await f.model.save(rule);
  f.model.apply({type:'advertise',revision:1,ip:peerIP,exports:[{...rule,generation,enabled:true}]},'bob',false);
  await f.model.toggleNetwork('bob',rule.id,true);
  f.model.apply({type:'advertise',revision:2,ip:peerIP,exports:[{...rule,generation,enabled:false}]},'bob',false);
  assert.equal(f.model.networkConnections.size,0);
  f.model.apply({type:'advertise',revision:3,ip:peerIP,exports:[{...rule,generation,enabled:true}]},'bob',false);
  await f.model.toggleNetwork('bob',rule.id,true);
  f.model.apply({type:'advertise',revision:4,ip:[10,160,1,3].join('.'),exports:[{...rule,generation,enabled:true}]},'bob',false);
  assert.equal(f.model.networkConnections.size,0);
  f.model.destroy();
});
test('revoking one remote rule leaves the other selected rule enabled', async () => {
  const f = fixture(); f.model.setParticipants(['alice','bob']); await f.model.save(rule);
  const second = { ...rule, id: '66666666-6666-4666-8666-666666666666', name: 'Another server', port: 23456, protocol: 'udp' as const };
  f.model.apply({type:'advertise',revision:1,ip:peerIP,exports:[{...rule,generation,enabled:true},{...second,generation,enabled:true}]},'bob',false);
  await f.model.toggleNetwork('bob',rule.id,true); await f.model.toggleNetwork('bob',second.id,true);
  f.model.apply({type:'advertise',revision:2,ip:peerIP,exports:[{...rule,generation,enabled:false},{...second,generation,enabled:true}]},'bob',false);
  assert.equal(f.model.networkConnections.size,1);
  assert.equal(f.model.networkConnections.has(f.model.networkKey('bob',second.id)),true);
  f.model.destroy();
});
