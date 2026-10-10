import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useId, useRef, useState } from 'react';
import { Tooltip } from './Tooltip';
import type { RendezvousTransport } from '../../core/types.ts';
import { normalizeRendezvousUrl, type RendezvousPreferences } from '../../p2p/relay_preferences.ts';

const labels: Record<RendezvousTransport, string> = {
  mqtt: 'MQTT',
  nostr: 'Nostr',
  torrent: 'WebTorrent',
};

interface Props {
  preferences: RendezvousPreferences;
  onChange: (value: RendezvousPreferences) => void;
}

export const RendezvousServerEditor: React.FC<Props> = ({ preferences, onChange }) => {
  useLocale();
  const id = useId();
  const tabs = useRef<Partial<Record<RendezvousTransport, HTMLButtonElement>>>({});
  const [transport, setTransport] = useState<RendezvousTransport>('mqtt');
  const [newUrl, setNewUrl] = useState('');
  const [error, setError] = useState('');

  const update = (entries: RendezvousPreferences[RendezvousTransport]) => {
    onChange({ ...preferences, [transport]: entries });
    setError('');
  };

  const setAllEnabled = (enabled: boolean) => {
    update(preferences[transport].map((entry) => ({ ...entry, enabled })));
  };

  const add = () => {
    const url = normalizeRendezvousUrl(newUrl);
    if (!url) {
      setError(t("message.a3405b1e2616"));
      return;
    }
    if (preferences[transport].some((entry) => normalizeRendezvousUrl(entry.url) === url)) {
      setError(t("message.e3a7d63e7255"));
      return;
    }
    update([...preferences[transport], { url, enabled: true }]);
    setNewUrl('');
  };

  return (
    <div className="rendezvous-editor">
      <div className="sidebar-tabs settings-subtabs" role="tablist" aria-label={t("message.a640b99a4711")}>
        {(['mqtt', 'nostr', 'torrent'] as const).map((item) => (
          <button key={item} type="button" className={`tab-btn ${transport === item ? 'active' : ''}`}
            ref={element => { if (element) tabs.current[item] = element; else delete tabs.current[item]; }}
            role="tab" id={`${id}-${item}`} aria-selected={transport === item}
            aria-controls={`${id}-panel`} tabIndex={transport === item ? 0 : -1}
            onClick={() => { setTransport(item); setError(''); }} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const order: RendezvousTransport[] = ['mqtt', 'nostr', 'torrent'];
              const index = order.indexOf(item);
              const next = event.key === 'Home' ? order[0] : event.key === 'End' ? order[2]
                : order[(index + (event.key === 'ArrowRight' ? 1 : 2)) % order.length];
              setTransport(next); setError(''); tabs.current[next]?.focus();
            }}>
            {labels[item]}
          </button>
        ))}
      </div>
      <div className="rendezvous-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${transport}`}>
      <div className="rendezvous-bulk-actions" role="group" aria-label={t("message.c8d0c8a15130", { v0: labels[transport] })}>
        <button type="button" className="btn btn-sm btn-outline"
          disabled={!preferences[transport].some((server) => !server.enabled)}
          onClick={() => setAllEnabled(true)}>{t("message.c2f729ba4f91")}</button>
        <button type="button" className="btn btn-sm btn-outline"
          disabled={!preferences[transport].some((server) => server.enabled)}
          onClick={() => setAllEnabled(false)}>{t("message.91bd720166c7")}</button>
      </div>
      <div className="rendezvous-list">
        {preferences[transport].length === 0 && <p className="settings-pane-desc">{t("message.022956c958fc")}</p>}
        {preferences[transport].map((server, index) => (
          <div className="rendezvous-item" key={`${server.url}-${index}`}>
            <Tooltip content={server.url}><span className="rendezvous-server-url">{server.url}</span></Tooltip>
            <button type="button" className="btn btn-sm btn-outline btn-outline-danger"
              aria-label={t("message.36e48c875542", { v0: server.url })}
              onClick={() => update(preferences[transport].filter((_, i) => i !== index))}>{t("message.a3037dc71a43")}</button>
            <Tooltip content={server.enabled ? t("message.c9a96463786f") : t("message.745291324ef4")}><label className="modern-switch">
              <input autoComplete="off" type="checkbox" checked={server.enabled} aria-label={t("message.a11b45ca2c92", { v0: server.url })}
                onChange={(event) => update(preferences[transport].map((entry, i) => i === index ? { ...entry, enabled: event.target.checked } : entry))} />
              <span className="switch-slider" aria-hidden="true" />
            </label></Tooltip>
          </div>
        ))}
      </div>
      <div className="rendezvous-add">
        <input autoComplete="off" className="text-input-sm" type="url" value={newUrl} placeholder={t("message.585f121d3f97")}
          aria-label={t("message.97e5e023632c", { v0: labels[transport] })} onChange={(event) => { setNewUrl(event.target.value); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" className="btn btn-sm btn-outline" onClick={add}>{t("message.967bcf34a913")}</button>
      </div>
      {error && <p className="rendezvous-error" role="alert">{localizeText(error)}</p>}
      </div>
    </div>
  );
};
