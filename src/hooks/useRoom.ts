import { useEffect, useState, useCallback } from 'react';
import { roomService } from '../services/room_service';
import { stateStore } from '../core/state_store';
import { useStore } from './useStore';

export function useRoom() {
  const roomSlots = useStore((s) => s.roomSlots);
  const layoutMode = useStore((s) => s.layoutMode);
  const pinnedPeerId = useStore((s) => s.pinnedPeerId);
  const isSharingScreen = useStore((s) => s.isSharingScreen);
  const currentRoomCode = useStore((s) => s.currentRoomCode);
  const currentRoomPassword = useStore((s) => s.currentRoomPassword);
  const isCreator = useStore((s) => s.isCreator);
  const username = useStore((s) => s.username);
  const isSidebarCollapsed = useStore((s) => s.isSidebarCollapsed);
  const isSpotlightTrayCollapsed = useStore((s) => s.isSpotlightTrayCollapsed);
  const streamFilter = useStore((s) => s.streamFilter);

  const [, setServiceTick] = useState(0);

  useEffect(() => {
    return roomService.subscribe(() => {
      setServiceTick((t) => t + 1);
    });
  }, []);

  const joinRoom = useCallback((code: string, pass: string, isCreatorFlag: boolean) => {
    roomService.joinRoom(code, pass, isCreatorFlag);
  }, []);

  const leaveRoom = useCallback(() => {
    roomService.leaveRoom();
  }, []);

  const sendChatMessage = useCallback((text: string, replyToId?: string) => {
    roomService.sendChatMessage(text, replyToId);
  }, []);

  const editChatMessage = useCallback((id: string, text: string) => roomService.editChatMessage(id, text), []);
  const deleteChatMessage = useCallback((id: string) => roomService.deleteChatMessage(id), []);

  const updateRoomPassword = useCallback((newPassword: string) => {
    roomService.updateRoomPassword(newPassword);
  }, []);

  const requestStream = useCallback((peerId: string) => {
    roomService.requestStream(peerId);
  }, []);

  const stopWatchingStream = useCallback((peerId: string) => {
    roomService.stopWatchingStream(peerId);
  }, []);

  const stopScreenSharing = useCallback(() => {
    roomService.stopScreenSharing();
  }, []);

  const togglePin = useCallback((peerId: string) => {
    stateStore.set((s) => {
      if (s.layoutMode === 'grid') {
        s.pinnedPeerId = peerId;
        s.layoutMode = 'spotlight';
      } else {
        if (s.pinnedPeerId === peerId) {
          s.layoutMode = 'grid';
          s.pinnedPeerId = null;
        } else {
          s.pinnedPeerId = peerId;
        }
      }
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    stateStore.set((s) => {
      s.isSidebarCollapsed = !s.isSidebarCollapsed;
    });
  }, []);

  const toggleSpotlightTray = useCallback(() => {
    stateStore.set((s) => {
      s.isSpotlightTrayCollapsed = !s.isSpotlightTrayCollapsed;
    });
  }, []);

  const setStreamFilter = useCallback((filter: import('../core/types').StreamFilterMode) => {
    stateStore.set((s) => {
      s.streamFilter = filter;
    });
  }, []);

  return {
    // State
    roomSlots,
    layoutMode,
    pinnedPeerId,
    isSharingScreen,
    currentRoomCode,
    currentRoomPassword,
    isCreator,
    username,
    isSidebarCollapsed,
    isSpotlightTrayCollapsed,
    streamFilter,
    chatMessages: roomService.chatMessages,
    peers: roomService.peers,
    roomStatusText: roomService.roomStatusText,
    connectingOverlay: roomService.connectingOverlay,
    isInRoom: roomSlots.length > 0 && Boolean(currentRoomCode),

    // Actions
    joinRoom,
    leaveRoom,
    sendChatMessage,
    editChatMessage,
    deleteChatMessage,
    updateRoomPassword,
    requestStream,
    stopWatchingStream,
    stopScreenSharing,
    togglePin,
    toggleSidebar,
    toggleSpotlightTray,
    setStreamFilter,
    getPeerPing: (peerId: string) => roomService.getPeerPing(peerId),
    hideConnecting: () => roomService.hideConnecting(),
  };
}
