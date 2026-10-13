import { useEffect, useState } from 'react';
import { Network, Plus, Pencil, Trash2, Copy, RefreshCw } from 'lucide-react';
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
import { TunnelModel, type TunnelCounters, type NetworkCounters } from './tunnel_model';
import { validTunnelRule, type TunnelRule } from './tunnel_rules';

function TunnelStats({ counters }: { counters?: TunnelCounters | NetworkCounters }) {
  if (!counters) return null;
  const amount = (bytes: number) => (bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return <div className="tunnel-stats">
    <div className="tunnel-traffic"><span className="tunnel-upload" aria-label={t('tunnels.upload', { amount: amount(counters.sent) })}>↑ {amount(counters.sent)} KiB</span>
      <span className="tunnel-download" aria-label={t('tunnels.download', { amount: amount(counters.received) })}>↓ {amount(counters.received)} KiB</span></div>
    <span>{'dropped' in counters ? t('tunnels.dropped', { count: counters.dropped }) : t('tunnels.connections', { count: counters.sessions })}</span>
  </div>;
}

function TunnelRuleDialog({ rule, model, onClose }: { rule: TunnelRule; model: TunnelModel; onClose: () => void }) {
  const [name, setName] = useState(rule.name);
  const [port, setPort] = useState(String(rule.port));
  const [protocol, setProtocol] = useState(rule.protocol);
  const [mode, setMode] = useState(rule.mode || 'proxy');
  const [allPorts, setAllPorts] = useState(rule.protocol === 'any');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const next: TunnelRule = { id: rule.id, name: name.trim(), port: allPorts ? 0 : Number(port),
      protocol: allPorts ? 'any' : protocol, ...(mode === 'virtual' ? { mode: 'virtual' } : {}) };
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
      <label>{t('virtualNetwork.mode')}<Select value={mode} disabled={busy}
        options={[{ value: 'virtual', label: t('virtualNetwork.virtualMode') }, { value: 'proxy', label: t('virtualNetwork.proxyMode') }]}
        onValueChange={(value) => { setMode(value); if (value === 'proxy') { setAllPorts(false); if (protocol === 'any') setProtocol('tcp'); if (Number(port) === 0) setPort('25565'); } }} /></label>
      {mode === 'virtual' && <label className="tunnel-access-option">{t('virtualNetwork.allPorts')}
        <span className="modern-switch"><input type="checkbox" checked={allPorts} disabled={busy}
          onChange={(event) => { setAllPorts(event.target.checked); if (!event.target.checked && protocol === 'any') setProtocol('tcp'); }} /><span className="switch-slider" /></span>
      </label>}
      {!allPorts && <>
      <label>{t('tunnels.protocol')}<Select value={protocol} options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]}
        onValueChange={(value) => setProtocol(value as 'tcp' | 'udp')} disabled={busy} /></label>
      <label>{t('tunnels.servicePort')}<input className="text-input" autoComplete="off" type="number" min={1} max={65535}
        value={port} onChange={(event) => setPort(event.target.value)} disabled={busy} /></label>
      </>}
      {mode === 'virtual' && <p className="tunnel-hint">{t('virtualNetwork.consent')}</p>}
      {rule.name && <p className="tunnel-hint">{t('tunnels.editDisables')}</p>}
      {error && <p role="alert" className="tunnel-error">{error}</p>}
    </form>
  </ModalDialog>;
}

export function TunnelApp({ instanceId, compact = false }: { instanceId: string; compact?: boolean }) {
  useLocale();
  const { peers } = useRoom();
  const [, update] = useState(0);
  useEffect(() => roomAppsService.subscribe(() => update((n) => n + 1)), []);
  const model = roomAppsService.getModel<TunnelModel>(instanceId);
  const [editing, setEditing] = useState<TunnelRule | null>(null);
  const [deleting, setDeleting] = useState<TunnelRule | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  if (!model) return null;
  const run = (operation: Promise<void>) => void operation.catch((reason) => showToast(localizeError(reason), 4000, 'error'));
  const remoteRows = [...model.remote].flatMap(([peer, rules]) => rules.filter((rule) => rule.enabled).map((rule) => ({ peer, rule })));
  const avatar = (peer: string, name: string) => <Tooltip content={name}>
    <ProfileAvatar className="room-app-participant" name={name} peerId={peer} tabIndex={0} />
  </Tooltip>;
  if (compact) return <div className="tunnel-preview">
    <Network size={32} strokeWidth={1.5} aria-hidden="true" />
    <strong>{t('tunnels.previewActive', { count: model.active.size + remoteRows.length })}</strong>
  </div>;
  return <div className={`room-app-tunnels ${compact ? 'compact' : ''}`} onClick={(event) => event.stopPropagation()}>
    {!compact && model.ip && <div className="tunnel-network-toolbar">
      <Network size={16} /><span>{t('virtualNetwork.ip')}</span><code>{model.ip}</code>
      <TooltipButton tooltip={t('tunnels.copy')} aria-label={t('tunnels.copy')} className="btn btn-sm btn-secondary"
        onClick={() => { void navigator.clipboard.writeText(model.ip).catch((reason) => showToast(localizeError(reason), 3500, 'error')); }}><Copy size={15} /></TooltipButton>
      <TooltipButton tooltip={t('virtualNetwork.refresh')} aria-label={t('virtualNetwork.refresh')} className="btn btn-sm btn-secondary"
        disabled={model.busy || model.networkConnections.size > 0 || [...model.active.values()].some((r) => r.mode === 'virtual')} onClick={() => setRegenerating(true)}><RefreshCw size={15} /></TooltipButton>
    </div>}
    {!model.available && <p role="status" className="tunnel-hint">{t('tunnels.desktopOnly')}</p>}
    {model.error && <p role="alert" className="tunnel-error">{localizeError(model.error)}</p>}
    <div className="tunnel-lists">
      <section aria-label={t('tunnels.mine')}>
        <div className="tunnel-list-header"><h3>{t('tunnels.mine')}</h3>
          {!compact && <button className="btn btn-sm btn-primary" disabled={model.busy || model.rules.length >= 32}
            onClick={() => setEditing({ id: crypto.randomUUID(), name: '', port: 25565, protocol: 'tcp', mode: 'virtual' })}>
            <Plus size={15} />{t('tunnels.create')}</button>}
        </div>
        <div className="tunnel-list-content">
        {!model.rules.length && <p className="tunnel-empty">{t('tunnels.emptyMine')}</p>}
        {model.rules.map((rule) => <div className="tunnel-row" key={rule.id}>
          <div className="tunnel-details"><strong>{rule.name}</strong>
            <span>{rule.protocol === 'any' ? t('virtualNetwork.allPorts') : `${rule.protocol.toUpperCase()} · ${rule.port}`}
              {rule.mode === 'virtual' && model.ip ? ` · ${model.ip}` : ''}</span>
            <TunnelStats counters={rule.mode === 'virtual' ? model.networkCounters[rule.id] : model.status.counters[rule.id]} /></div>
          {!compact && <div className="tunnel-actions">
            <TooltipButton tooltip={t('tunnels.edit')} aria-label={t('tunnels.edit')} className="btn btn-sm btn-secondary"
              disabled={model.busy} onClick={() => setEditing(rule)}><Pencil size={15} /></TooltipButton>
            <TooltipButton tooltip={t('tunnels.delete')} aria-label={t('tunnels.delete')} className="btn btn-sm btn-secondary"
              disabled={model.busy} onClick={() => setDeleting(rule)}><Trash2 size={15} /></TooltipButton>
            <label className="modern-switch"><input type="checkbox" checked={model.active.has(rule.id)}
              aria-label={t('tunnels.enable', { name: rule.name })} disabled={model.busy || !model.available}
              onChange={(event) => run(model.toggle(rule.id, event.target.checked))} /><span className="switch-slider" /></label>
          </div>}
        </div>)}
        </div>
      </section>
      <section aria-label={t('tunnels.others')}>
        <div className="tunnel-list-header"><h3>{t('tunnels.others')}</h3></div>
        <div className="tunnel-list-content">
        {!remoteRows.length && <p className="tunnel-empty">{t('tunnels.emptyOthers')}</p>}
        {remoteRows.map(({ peer, rule }) => {
          const name = peers.find((p) => p.id === peer)?.username || t('tunnels.participant');
          const forward = model.status.forwards.find((f) => f.peer === peer && f.tunnel === rule.id);
          const virtual = rule.mode === 'virtual';
          const ip = model.remoteIPs.get(peer);
          const address = virtual && ip ? (rule.protocol === 'any' ? ip : `${ip}:${rule.port}`) : forward ? `127.0.0.1:${forward.port}` : '';
          return <div className="tunnel-row" key={`${peer}:${rule.id}`}>
            <div className="tunnel-details"><div className="tunnel-title">{avatar(peer, name)}<strong>{rule.name}</strong></div>
              <span>{rule.protocol === 'any' ? t('virtualNetwork.allPorts') : `${rule.protocol.toUpperCase()} · ${rule.port}`}</span>
              {(forward || virtual && ip) && <code>{address}</code>}
              <TunnelStats counters={virtual ? model.networkCounters[rule.id] : forward ? model.status.counters[forward.id] : undefined} />
            </div>
            {!compact && <div className="tunnel-actions">
              {address && <TooltipButton tooltip={t('tunnels.copy')} aria-label={t('tunnels.copy')} className="btn btn-sm btn-secondary"
                onClick={() => { void navigator.clipboard.writeText(address).then(() => showToast(t('tunnels.copied'), 2000, 'success')).catch((reason) => showToast(localizeError(reason), 3500, 'error')); }}><Copy size={15} /></TooltipButton>}
            </div>}
          </div>;
        })}
        </div>
      </section>
    </div>
    {editing && <TunnelRuleDialog rule={editing} model={model} onClose={() => setEditing(null)} />}
    {regenerating && <ModalDialog title={t('virtualNetwork.refresh')} onClose={() => setRegenerating(false)} busy={model.busy}
      footer={(close) => <><button className="btn btn-secondary" disabled={model.busy} onClick={close}>{t('tunnels.cancel')}</button>
        <button className="btn btn-primary" disabled={model.busy} onClick={() => run(model.regenerateIP().then(() => setRegenerating(false)))}>{t('virtualNetwork.refresh')}</button></>}>
      <p>{t('virtualNetwork.refreshConfirm')}</p>
    </ModalDialog>}
    {deleting && <ModalDialog title={t('tunnels.delete')} onClose={() => setDeleting(null)} busy={model.busy}
      footer={(close) => <><button className="btn btn-secondary" onClick={close} disabled={model.busy}>{t('tunnels.cancel')}</button>
        <button className="btn btn-danger" disabled={model.busy} onClick={() => run(model.delete(deleting.id).then(() => setDeleting(null)))}>{t('tunnels.delete')}</button></>}>
      <p>{t('tunnels.deleteConfirm', { name: deleting.name })}</p>
    </ModalDialog>}
  </div>;
}
