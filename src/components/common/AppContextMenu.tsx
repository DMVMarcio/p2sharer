import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { type ReactNode } from 'react';
import { Grid2X2, MessageSquare, MonitorUp, Settings, UserRound } from 'lucide-react';
import { ContextMenuProvider, type ContextMenuAction } from './ContextMenu';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';

export function AppContextMenu({ children }: { children: ReactNode }) {
  useLocale();
  const { isInRoom, layoutMode, isSidebarCollapsed, toggleSidebar, isSharingScreen, stopScreenSharing, returnToGrid } = useRoom();
  const { openModal } = useModal();
  const pip = new URLSearchParams(window.location.search).has('pip');
  const getActions = (): ContextMenuAction[] => {
    if (pip) return [];
    const actions: ContextMenuAction[] = [];
    if (isInRoom) {
      if (layoutMode === 'spotlight') actions.push({ id: 'grid', get label() { return t("message.2e00d3a9b870"); }, icon: <Grid2X2 size={15} />,
        onSelect: returnToGrid });
      actions.push({ id: 'sidebar', get label() { return isSidebarCollapsed ? t("message.c74b96d4e66a") : t("message.8eacb9d12b07"); },
        icon: <MessageSquare size={15} />, onSelect: toggleSidebar });
      actions.push({ id: 'share', get label() { return isSharingScreen ? t("message.6ef17b51fd93") : t("message.85344dae041c"); }, icon: <MonitorUp size={15} />,
        onSelect: isSharingScreen ? stopScreenSharing : () => openModal('screenPicker') });
    }
    actions.push({ id: 'username', get label() { return t("message.931f04601e43"); }, icon: <UserRound size={15} />, onSelect: () => openModal('username') });
    actions.push({ id: 'settings', get label() { return t("message.76b0fb6ad189"); }, icon: <Settings size={15} />, onSelect: () => openModal('settings') });
    return actions;
  };
  return <ContextMenuProvider getActions={getActions}>{children}</ContextMenuProvider>;
}
