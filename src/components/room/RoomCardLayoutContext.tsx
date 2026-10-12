import { createContext, useContext, forwardRef, type HTMLAttributes } from 'react';
import { RotateCcw } from 'lucide-react';
import { t } from '../../i18n';
import { useContextMenu, isContextMenuEditor, type ContextMenuAction } from '../common/ContextMenu';

export const RoomCardLayoutContext = createContext<(() => void) | null>(null);

export function useRoomCardLayoutActions(): ContextMenuAction[] {
  const reset = useContext(RoomCardLayoutContext);
  return reset ? [{ id: 'reset-card-layout', get label() { return t('room.cards.reset'); }, icon: <RotateCcw size={15} />,
    separator: true, onSelect: reset }] : [];
}

export const RoomCardLayoutSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>((props, ref) => {
  const actions = useRoomCardLayoutActions();
  const open = useContextMenu();
  return <div {...props} ref={ref} onContextMenu={event => {
    if (!event.defaultPrevented && !isContextMenuEditor(event.target)) open(event, actions);
  }} />;
});
