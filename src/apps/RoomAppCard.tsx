import React, { Suspense, lazy, useEffect, useState } from 'react';
import type { RoomAppInstance } from './types';
import { getRoomApp, type RoomAppViewProps } from './registry';
import { roomAppsService } from './room_apps_service';
import { useRoom } from '../hooks/useRoom';
import { AppWindow, ArrowLeft, MoreHorizontal, SquareX } from 'lucide-react';
import { ActivityParticipants } from '../components/common/ActivityParticipants';
import { Tooltip } from '../components/common/Tooltip';
import { stateStore } from '../core/state_store';

const views = new Map<string, React.LazyExoticComponent<React.ComponentType<RoomAppViewProps>>>();
function viewFor(kind: string) {
  let view = views.get(kind);
  const definition = getRoomApp(kind);
  if (!view && definition) {
    view = lazy(definition.loadView);
    views.set(kind, view);
  }
  return view;
}

interface Props {
  instance: RoomAppInstance;
  isFeatured?: boolean;
  compact?: boolean;
  style?: React.CSSProperties;
}

export const RoomAppCard: React.FC<Props> = ({ instance, isFeatured = false, compact = false, style }) => {
  const { togglePin, peers, roomSlots, username } = useRoom();
  const [, setPresenceTick] = useState(0);
  useEffect(() => roomAppsService.subscribe(() => setPresenceTick((tick) => tick + 1)), []);
  const joined = roomAppsService.isJoined(instance.id);
  const people = roomAppsService.getParticipants(instance.id).map((id) => {
    const local = id === roomAppsService.getLocalActor();
    const peer = peers.find((entry) => entry.id === id);
    const name = local ? username || 'Você' : peer?.username || 'Participante';
    const slot = roomSlots.find((entry) => local ? entry.isLocal : entry.peerId === id);
    return { id, name, color: slot?.color || 'var(--accent-color)' };
  });
  const enter = () => {
    roomAppsService.join(instance.id);
    if (compact) togglePin(`app:${instance.id}`);
  };
  const leave = () => {
    roomAppsService.leave(instance.id);
    if (isFeatured) backToGrid();
  };
  const backToGrid = () => {
    if (isFeatured) stateStore.set((state) => {
      state.layoutMode = 'grid';
      state.pinnedPeerId = null;
    });
  };
  const definition = getRoomApp(instance.kind);
  const label = definition?.label || instance.kind;
  const Icon = definition?.icon || AppWindow;
  const View = viewFor(instance.kind);
  return <div className={`room-app-card ${isFeatured ? 'featured' : ''} ${compact ? 'compact' : ''}`}
    style={style} data-peer-id={`app:${instance.id}`}>
    <div className="room-app-card-header">
      <span className="room-app-card-title"><Icon size={16} strokeWidth={1.8} />{label}
        <span className="room-app-shared-label">na sala</span></span>
      <div className="room-app-toolbar-actions">
        <ActivityParticipants people={people} />
        {isFeatured && <button className="room-app-leave-button" onClick={backToGrid}>
          <ArrowLeft size={14} /> Voltar para grade
        </button>}
        <details className="room-app-options">
          <Tooltip content="Opções do App">
            <summary aria-label={`Opções de ${label}`}><MoreHorizontal size={18} /></summary>
          </Tooltip>
          <div className="room-app-options-menu">
            {joined && <button onClick={leave}><ArrowLeft size={15} /> Sair da atividade</button>}
            <button onClick={() => roomAppsService.stop(instance.id)}><SquareX size={15} /> Encerrar para todos</button>
          </div>
        </details>
      </div>
    </div>
    <div className="room-app-card-body">
      {joined ? <Suspense fallback={<div className="room-app-player-placeholder">Carregando App...</div>}>
        {View && <View instanceId={instance.id} compact={compact} />}
      </Suspense> : <div className="room-app-join-panel">
        <Icon size={compact ? 25 : 32} strokeWidth={1.5} />
        {!compact && <><strong>{label}</strong><span>Atividade compartilhada na sala</span></>}
        <button onClick={enter}>Entrar na atividade</button>
        {!compact && <ActivityParticipants people={people} />}
      </div>}
    </div>
    {compact && joined && <button className="room-app-focus-overlay" aria-label={`Destacar ${label}`}
      onClick={() => togglePin(`app:${instance.id}`)} />}
  </div>;
};
