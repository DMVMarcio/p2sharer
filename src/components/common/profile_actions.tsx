import { UserRound } from 'lucide-react';
import { t } from '../../i18n';
import { modalManager, type ProfileTarget } from '../../hooks/useModal';
import type { ContextMenuAction } from './ContextMenu';

export function profileAction(target: ProfileTarget): ContextMenuAction {
  return { id: 'profile', get label() { return t('profile.view'); }, icon: <UserRound size={15} />,
    onSelect: () => modalManager.openProfile(target) };
}
