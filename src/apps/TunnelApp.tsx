import { useEffect, useState } from 'react';
import { Network, Plus, Pencil, Trash2, Copy } from 'lucide-react';
import { t, localizeError } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import { useRoom } from '../hooks/useRoom';
import { showToast } from '../hooks/useToast';
import { ModalDialog } from '../components/common/ModalDialog';
import { Select } from '../components/common/Select';
import { Tooltip } from '../components/common/Tooltip';
import { TooltipButton } from '../components/common/TooltipButton';
import { ProfileAvatar } from '../components/common/ProfileAvatar';
import { roomAppsService } from './room_apps_service';
import { TunnelModel, type TunnelCounters } from './tunnel_model';
import { validTunnelRule, type TunnelRule } from './tunnel_rules';

function TunnelStats({ counters }: { counters?: TunnelCounters }) {
  if (!counters) return null;
  return <span className="tunnel-stats">{t('tunnels.stats', { sessions: counters.sessions,
    sent: (counters.sent / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }),
    received: (counters.received / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) })}</span>;
}

function TunnelRuleDialog({ rule, model, onClose }: { rule: TunnelRule; model: TunnelModel; onClose: () => void }) {
  const [name, setName] = useState(rule.name);
  const [port, setPort] = useState(String(rule.port));
  const [protocol, setProtocol] = useState(rule.protocol);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const next = { id: rule.id, name: name.trim(), port: Number(port), protocol };
    if (!validTunnelRule(next)) { setError(t('tunnels.invalid')); return; }
    setBusy(true);
    try { await model.save(next); onClose(); }
    catch (reason) { setError(localizeError(reason)); }
    finally { setBusy(false); }
  };
  return <ModalDialog title={rule.name ? t('tunnels.edit') : t('tunnels.create')} icon={<Network size={22} />}
    busy={busy} onClose={onClose} footer={(close) => <>
      <button className="btn btn-secondary" onClick={close} disabled={busy}>{t('tunnels.cancel')}</button>
      <button className="btn btn-primary" onClick={save} disabled={busy}>{t('tunnels.save')}</button>
    </>}>
    <form className="tunnel-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>{t('tunnels.name')}<input className="text-input" autoComplete="off" autoFocus maxLength={80} value={name}
        onChange={(event) => setName(event.target.value)} disabled={busy} /></label>
      <label>{t('tunnels.protocol')}<Select value={protocol} options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]}
        onValueChange={(value) => setProtocol(value as 'tcp' | 'udp')} disabled={busy} /></label>
      <label>{t('tunnels.servicePort')}<input className="text-input" autoComplete="off" type="number" min={1} max={65535}
        value={port} onChange={(event) => setPort(event.target.value)} disabled={busy} /></label>
      <p className="tunnel-hint">{t('tunnels.localService')}</p>
      {rule.name && <p className="tunnel-hint">{t('tunnels.editDisables')}</p>}
      {error && <p role="alert" className="tunnel-error">{error}</p>}
    </form>
  </ModalDialog>;
}

function TunnelConnectDialog({ peer, rule, model, onClose }: { peer: string; rule: TunnelRule; model: TunnelModel; onClose: () => void }) {
  const [port, setPort] = useState(String(model.localPort(rule.id, rule.port)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = async () => {
    if (!port.trim() || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) { setError(t('tunnels.invalid')); return; }
    setBusy(true);
    try { await model.connect(peer, rule.id, Number(port)); onClose(); }
    catch (reason) { setError(localizeError(reason)); }
    finally { setBusy(false); }
  };
  return <ModalDialog title={t('tunnels.connectTo', { name: rule.name })} busy={busy} onClose={onClose}
    footer={(close) => <><button className="btn btn-secondary" onClick={close} disabled={busy}>{t('tunnels.cancel')}</button>
      <button className="btn btn-primary" onClick={connect} disabled={busy}>{t('tunnels.connect')}</button></>}>
    <form className="tunnel-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <label>{t('tunnels.localPort')}<input className="text-input" autoComplete="off" autoFocus type="number" min={0} max={65535}
        value={port} onChange={(event) => setPort(event.target.value)} disabled={busy} /></label>
      <p className="tunnel-hint">{t('tunnels.portHelp')}</p>
      {error && <p role="alert" className="tunnel-error">{error}</p>}
    </form>
  </ModalDialog>;
}

export function TunnelApp({ instanceId, compact = false }: { instanceId: string; compact?: boolean }) {
  useLocale();
  const { peers, username } = useRoom();
  const [, update] = useState(0);
  useEffect(() => roomAppsService.subscribe(() => update((n) => n + 1)), []);
  const model = roomAppsService.getModel<TunnelModel>(instanceId);
  const [editing, setEditing] = useState<TunnelRule | null>(null);
  const [deleting, setDeleting] = useState<TunnelRule | null>(null);
  const [connecting, setConnecting] = useState<{ peer: string; rule: TunnelRule } | null>(null);
  if (!model) return null;
  const run = (operation: Promise<void>) => void operation.catch((reason) => showToast(localizeError(reason), 4000, 'error'));
  const localName = username || t('tunnels.you');
  const remoteRows = [...model.remote].flatMap(([peer, rules]) => rules.map((rule) => ({ peer, rule })));
  const avatar = (peer: string, name: string, local = false) => <Tooltip content={name}>
    <ProfileAvatar className="room-app-participant" name={name} peerId={peer} isLocal={local} tabIndex={0} />
  </Tooltip>;
  return <div className={`room-app-tunnels ${compact ? 'compact' : ''}`} onClick={(event) => event.stopPropagation()}>
    {!compact && <div className="tunnel-toolbar">
      <p className="tunnel-hint">{t('tunnels.manual')}</p>
      <button className="btn btn-sm btn-primary" disabled={model.busy || model.rules.length >= 32}
        onClick={() => setEditing({ id: crypto.randomUUID(), name: '', port: 25565, protocol: 'tcp' })}>
        <Plus size={15} />{t('tunnels.create')}</button>
    </div>}
    {!model.available && <p role="status" className="tunnel-hint">{t('tunnels.desktopOnly')}</p>}
    {model.error && <p role="alert" className="tunnel-error">{localizeError(model.error)}</p>}
    <div className="tunnel-lists">
      <section aria-label={t('tunnels.mine')}><h3>{t('tunnels.mine')}</h3>
        {!model.rules.length && <p className="tunnel-empty">{t('tunnels.emptyMine')}</p>}
        {model.rules.map((rule) => <div className="tunnel-row" key={rule.id}>
          {avatar('local', localName, true)}
          <div className="tunnel-details"><strong>{rule.name}</strong>
            <span>{rule.protocol.toUpperCase()} · {rule.port} · {model.active.has(rule.id) ? t('tunnels.active') : t('tunnels.inactive')}</span>
            <TunnelStats counters={model.status.counters[rule.id]} /></div>
          {!compact && <div className="tunnel-actions">
            <label className="modern-switch"><input type="checkbox" checked={model.active.has(rule.id)}
              aria-label={t('tunnels.enable', { name: rule.name })} disabled={model.busy || !model.available}
              onChange={(event) => run(model.toggle(rule.id, event.target.checked))} /><span className="switch-slider" /></label>
            <TooltipButton tooltip={t('tunnels.edit')} aria-label={t('tunnels.edit')} className="btn btn-sm btn-secondary"
              disabled={model.busy} onClick={() => setEditing(rule)}><Pencil size={15} /></TooltipButton>
            <TooltipButton tooltip={t('tunnels.delete')} aria-label={t('tunnels.delete')} className="btn btn-sm btn-secondary"
              disabled={model.busy} onClick={() => setDeleting(rule)}><Trash2 size={15} /></TooltipButton>
          </div>}
        </div>)}
      </section>
      <section aria-label={t('tunnels.others')}><h3>{t('tunnels.others')}</h3>
        {!remoteRows.length && <p className="tunnel-empty">{t('tunnels.emptyOthers')}</p>}
        {remoteRows.map(({ peer, rule }) => {
          const name = peers.find((p) => p.id === peer)?.username || t('tunnels.participant');
          const forward = model.status.forwards.find((f) => f.peer === peer && f.tunnel === rule.id);
          const address = forward ? `127.0.0.1:${forward.port}` : '';
          return <div className="tunnel-row" key={`${peer}:${rule.id}`}>
            {avatar(peer, name)}<div className="tunnel-details"><strong>{rule.name}</strong>
              <span>{rule.protocol.toUpperCase()} · {rule.port} · {name} · {rule.enabled ? t('tunnels.active') : t('tunnels.inactive')}</span>
              {forward && <><code>{address}</code><TunnelStats counters={model.status.counters[forward.id]} /></>}
            </div>
            {!compact && <div className="tunnel-actions">
              {forward && <TooltipButton tooltip={t('tunnels.copy')} aria-label={t('tunnels.copy')} className="btn btn-sm btn-secondary"
                onClick={() => { void navigator.clipboard.writeText(address).then(() => showToast(t('tunnels.copied'), 2000, 'success')).catch((reason) => showToast(localizeError(reason), 3500, 'error')); }}><Copy size={15} /></TooltipButton>}
              <label className="modern-switch"><input type="checkbox" checked={Boolean(forward)}
                aria-label={t('tunnels.connectTo', { name: rule.name })} disabled={model.busy || !model.available || (!rule.enabled && !forward)}
                onChange={() => forward ? run(model.disconnect(forward.id)) : setConnecting({ peer, rule })} /><span className="switch-slider" /></label>
            </div>}
          </div>;
        })}
      </section>
    </div>
    {editing && <TunnelRuleDialog rule={editing} model={model} onClose={() => setEditing(null)} />}
    {connecting && <TunnelConnectDialog {...connecting} model={model} onClose={() => setConnecting(null)} />}
    {deleting && <ModalDialog title={t('tunnels.delete')} onClose={() => setDeleting(null)} busy={model.busy}
      footer={(close) => <><button className="btn btn-secondary" onClick={close} disabled={model.busy}>{t('tunnels.cancel')}</button>
        <button className="btn btn-danger" disabled={model.busy} onClick={() => run(model.delete(deleting.id).then(() => setDeleting(null)))}>{t('tunnels.delete')}</button></>}>
      <p>{t('tunnels.deleteConfirm', { name: deleting.name })}</p>
    </ModalDialog>}
  </div>;
}
