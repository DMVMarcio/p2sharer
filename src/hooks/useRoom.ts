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
  const currentRoomInvite = useStore((s) => s.currentRoomInvite);
  const currentRoomName = useStore((s) => s.currentRoomName);
  const currentRoomPassword = useStore((s) => s.currentRoomPassword);
  const isCreator = useStore((s) => s.isCreator);
  const username = useStore((s) => s.username);
  const isSidebarCollapsed = useStore((s) => s.isSidebarCollapsed);
  const sidebarTab = useStore((s) => s.sidebarTab);
  const unreadChatMessages = useStore((s) => s.unreadChatMessages);
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
    return roomService.updateRoomPassword(newPassword);
  }, []);
  const updateRoomName = useCallback((name: string) => roomService.updateRoomName(name), []);
  const transferOwnership = useCallback((peerId: string) => roomService.transferOwnership(peerId), []);
  const setAdministrator = useCallback((peerId: string, enabled: boolean) =>
    roomService.setAdministrator(peerId, enabled), []);
  const kickPeer = useCallback((peerId: string) => roomService.kickPeer(peerId), []);

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
      if (!s.isSidebarCollapsed && s.sidebarTab === 'chat') s.unreadChatMessages = 0;
    });
  }, []);

  const returnToGrid = useCallback(() => {
    stateStore.set((state) => { state.layoutMode = 'grid'; state.pinnedPeerId = null; });
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
    currentRoomInvite,
    currentRoomName,
    currentRoomPassword,
    isCreator,
    username,
    isSidebarCollapsed,
    sidebarTab,
    unreadChatMessages,
    isSpotlightTrayCollapsed,
    streamFilter,
    chatMessages: roomService.chatMessages,
    fileRequests: roomService.fileRequests,
    fileProgress: roomService.fileProgress,
    localFilePreviews: roomService.localFilePreviews,
    imagePreviews: roomService.imagePreviews,
    savedDownloads: roomService.savedDownloads,
    peers: roomService.peers,
    roomStatusText: roomService.roomStatusText,
    connectingOverlay: roomService.connectingOverlay,
    isInRoom: roomSlots.length > 0 && Boolean(currentRoomCode),
    isRoomHost: roomService.isRoomHost(),
    isRoomAdmin: roomService.isRoomAdmin(),

    // Actions
    joinRoom,
    leaveRoom,
    sendChatMessage,
    offerFile: roomService.offerFile.bind(roomService),
    requestFile: roomService.requestFile.bind(roomService),
    requestFilePreview: roomService.requestFilePreview.bind(roomService),
    dismissFileProgress: roomService.dismissFileProgress.bind(roomService),
    revealSavedFile: roomService.revealSavedFile.bind(roomService),
    answerFileRequest: roomService.answerFileRequest.bind(roomService),
    cancelFileTransfer: roomService.cancelFileTransfer.bind(roomService),
    editChatMessage,
    deleteChatMessage,
    updateRoomPassword,
    updateRoomName,
    transferOwnership,
    setAdministrator,
    kickPeer,
    requestStream,
    stopWatchingStream,
    stopScreenSharing,
    togglePin,
    returnToGrid,
    toggleSidebar,
    toggleSpotlightTray,
    setStreamFilter,
    getPeerPing: (peerId: string) => roomService.getPeerPing(peerId),
    hideConnecting: () => roomService.hideConnecting(),
  };
}
