import { type ReactNode } from 'react';
import { Grid2X2, MessageSquare, MonitorUp, Settings, UserRound } from 'lucide-react';
import { ContextMenuProvider, type ContextMenuAction } from './ContextMenu';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';

export function AppContextMenu({ children }: { children: ReactNode }) {
  const { isInRoom, layoutMode, isSidebarCollapsed, toggleSidebar, isSharingScreen, stopScreenSharing, returnToGrid } = useRoom();
  const { openModal } = useModal();
  const pip = new URLSearchParams(window.location.search).has('pip');
  const getActions = (): ContextMenuAction[] => {
    if (pip) return [];
    const actions: ContextMenuAction[] = [];
    if (isInRoom) {
      if (layoutMode === 'spotlight') actions.push({ id: 'grid', label: 'Voltar à grade', icon: <Grid2X2 size={15} />,
        onSelect: returnToGrid });
      actions.push({ id: 'sidebar', label: isSidebarCollapsed ? 'Abrir chat e participantes' : 'Ocultar chat e participantes',
        icon: <MessageSquare size={15} />, onSelect: toggleSidebar });
      actions.push({ id: 'share', label: isSharingScreen ? 'Parar transmissão' : 'Transmitir', icon: <MonitorUp size={15} />,
        onSelect: isSharingScreen ? stopScreenSharing : () => openModal('screenPicker') });
    }
    actions.push({ id: 'username', label: 'Alterar nome', icon: <UserRound size={15} />, onSelect: () => openModal('username') });
    actions.push({ id: 'settings', label: 'Configurações', icon: <Settings size={15} />, onSelect: () => openModal('settings') });
    return actions;
  };
  return <ContextMenuProvider getActions={getActions}>{children}</ContextMenuProvider>;
}
