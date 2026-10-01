import React, { useState } from 'react';
import type { SignalingTransport } from '../../core/types.ts';
import { normalizeRendezvousUrl, type RendezvousPreferences } from '../../p2p/relay_preferences.ts';

const labels: Record<SignalingTransport, string> = {
  mqtt: 'MQTT',
  nostr: 'Nostr',
  torrent: 'WebTorrent',
};

interface Props {
  preferences: RendezvousPreferences;
  onChange: (value: RendezvousPreferences) => void;
}

export const RendezvousServerEditor: React.FC<Props> = ({ preferences, onChange }) => {
  const [transport, setTransport] = useState<SignalingTransport>('mqtt');
  const [newUrl, setNewUrl] = useState('');
  const [error, setError] = useState('');

  const update = (entries: RendezvousPreferences[SignalingTransport]) => {
    onChange({ ...preferences, [transport]: entries });
    setError('');
  };

  const setAllEnabled = (enabled: boolean) => {
    update(preferences[transport].map((entry) => ({ ...entry, enabled })));
  };

  const add = () => {
    const url = normalizeRendezvousUrl(newUrl);
    if (!url) {
      setError('Use uma URL segura no formato wss://servidor.');
      return;
    }
    if (preferences[transport].some((entry) => normalizeRendezvousUrl(entry.url) === url)) {
      setError('Este servidor já está na lista.');
      return;
    }
    update([...preferences[transport], { url, enabled: true }]);
    setNewUrl('');
  };

  return (
    <div className="rendezvous-editor">
      <div className="rendezvous-tabs" role="group" aria-label="Protocolo de encontro">
        {(['mqtt', 'nostr', 'torrent'] as const).map((item) => (
          <button key={item} type="button" className={`btn btn-sm ${transport === item ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => { setTransport(item); setError(''); }} aria-pressed={transport === item}>
            {labels[item]}
          </button>
        ))}
      </div>
      <div className="rendezvous-bulk-actions" role="group" aria-label={`Servidores ${labels[transport]}`}>
        <button type="button" className="btn btn-sm btn-outline"
          disabled={!preferences[transport].some((server) => !server.enabled)}
          onClick={() => setAllEnabled(true)}>Ativar todos</button>
        <button type="button" className="btn btn-sm btn-outline"
          disabled={!preferences[transport].some((server) => server.enabled)}
          onClick={() => setAllEnabled(false)}>Desativar todos</button>
      </div>
      <div className="rendezvous-list">
        {preferences[transport].length === 0 && <p className="settings-pane-desc">Nenhum servidor cadastrado.</p>}
        {preferences[transport].map((server, index) => (
          <div className="rendezvous-item" key={`${server.url}-${index}`}>
            <span className="rendezvous-server-url" title={server.url}>{server.url}</span>
            <button type="button" className="btn btn-sm btn-outline btn-outline-danger"
              aria-label={`Remover ${server.url}`}
              onClick={() => update(preferences[transport].filter((_, i) => i !== index))}>Remover</button>
            <label className="modern-switch" title={server.enabled ? 'Desabilitar servidor' : 'Habilitar servidor'}>
              <input autoComplete="off" type="checkbox" checked={server.enabled} aria-label={`Habilitar ${server.url}`}
                onChange={(event) => update(preferences[transport].map((entry, i) => i === index ? { ...entry, enabled: event.target.checked } : entry))} />
              <span className="switch-slider" aria-hidden="true" />
            </label>
          </div>
        ))}
      </div>
      <div className="rendezvous-add">
        <input autoComplete="off" className="text-input-sm" type="url" value={newUrl} placeholder="wss://servidor.exemplo"
          aria-label={`Novo servidor ${labels[transport]}`} onChange={(event) => { setNewUrl(event.target.value); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" className="btn btn-sm btn-outline" onClick={add}>Adicionar</button>
      </div>
      {error && <p className="rendezvous-error" role="alert">{error}</p>}
    </div>
  );
};
