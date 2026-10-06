import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createTopicStrategy, type JoinRoom } from '@trystero-p2p/core';
import type { LanRoomConnection } from '../core/lan_room.ts';
import { LanRelay, type LanSignalDriver, type LanSignalEvent } from './lan_relay.ts';

const driver: LanSignalDriver = {
  listen: (id, receive) => listen<LanSignalEvent>(`lan-signaling-${id}`, ({ payload }) => receive(payload)),
  connect: (id, room, connection) => invoke('connect_lan_signaling', { id, room, ...connection }),
  send: (id, data) => invoke('send_lan_signaling', { id, data }),
  disconnect: (id) => invoke('disconnect_lan_signaling', { id }),
};

export interface LanSignalingRoom {
  relay: LanRelay;
  join: JoinRoom;
  close(): Promise<void>;
}

export async function prepareLanSignaling(connection: LanRoomConnection, room: string,
  host: boolean, status: (connected: boolean) => void): Promise<LanSignalingRoom> {
  let hosted = false;
  const relay = new LanRelay(driver, connection, room, status);
  const close = async () => {
    await relay.close();
    if (hosted) await invoke('stop_lan_signaling', { room });
  };
  try {
    if (host) {
      await invoke('start_lan_signaling', { room, ...connection });
      hosted = true;
    }
    await relay.start();
    // Trystero keeps its canonical peer identity, actions, media and encrypted SDP.
    const join = createTopicStrategy<LanRelay>({
      init: () => relay,
      subscribeTopic: (relay, topic, receive) => relay.subscribe(topic, receive),
      publishTopic: (relay, topic, message) => relay.publish(topic,
        typeof message === 'string' ? message : JSON.stringify(message)),
    });
    return { relay, join, close };
  } catch (error) {
    await close();
    throw error;
  }
}
