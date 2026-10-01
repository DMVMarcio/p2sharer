import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy } from 'lucide-react';
import { useDropdownPresence } from '../../hooks/useDropdownPresence';
import { showToast } from '../../hooks/useToast';
import { captureTextEditing, TEXT_EDITOR_SELECTOR } from '../../core/text_editing';
import { getTextEditingActions } from './text_editing_actions';
import { Tooltip } from './Tooltip';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  onSelect: () => void | Promise<unknown>;
  secondary?: Pick<ContextMenuAction, 'label' | 'icon' | 'disabled' | 'danger' | 'onSelect'>;
}

interface MenuState {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  source: HTMLElement;
}

type MenuEvent = { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number; currentTarget: EventTarget | null };
const MenuContext = createContext<(event: MenuEvent, actions: ContextMenuAction[]) => void>(() => {});
export const useContextMenu = () => useContext(MenuContext);

/** Feature menus defer editor targets to the central text editing menu. */
export function isContextMenuEditor(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(TEXT_EDITOR_SELECTOR));
}

export function ContextMenuProvider({ children, getActions = () => [] }: {
  children: ReactNode;
  getActions?: () => ContextMenuAction[];
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const presence = useDropdownPresence(menu);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef(menu);
  const actionsRef = useRef(getActions);
  currentRef.current = menu;
  actionsRef.current = getActions;
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const close = useCallback((restoreFocus = false) => {
    if (restoreFocus && currentRef.current?.source.isConnected) currentRef.current.source.focus({ preventScroll: true });
    setMenu(null);
  }, []);
  const open = useCallback((event: MenuEvent, actions: ContextMenuAction[]) => {
    event.preventDefault();
    event.stopPropagation();
    const source = event.currentTarget instanceof HTMLElement ? event.currentTarget : document.body;
    const bounds = source.getBoundingClientRect();
    setMenu(actions.length ? { actions, source,
      x: event.clientX || bounds.left + Math.min(bounds.width / 2, 24),
      y: event.clientY || bounds.top + Math.min(bounds.height / 2, 24) } : null);
  }, []);

  useEffect(() => {
    const preserveSelection = (event: MouseEvent) => {
      if (event.button !== 2 || !isContextMenuEditor(event.target)) return;
      const editing = captureTextEditing(event.target);
      if (editing?.selectedText && (editing.source === document.activeElement || editing.source.contains(document.activeElement))) event.preventDefault();
    };
    const fallback = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const editor = captureTextEditing(event.target);
      if (editor) {
        open({ clientX: event.clientX, clientY: event.clientY, currentTarget: editor.source,
          preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, getTextEditingActions(editor));
        return;
      }
      const selection = window.getSelection()?.toString();
      const actions: ContextMenuAction[] = selection ? [{ id: 'copy-selection', label: 'Copiar seleção', icon: <Copy size={15} />,
        onSelect: () => navigator.clipboard.writeText(selection) }] : [];
      // Modal backgrounds must not expose actions belonging to the room behind them.
      if (!(event.target instanceof Element && event.target.closest('.modal-overlay, [role="dialog"], [role="alertdialog"]'))) actions.push(...actionsRef.current());
      open(event, actions);
    };
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const blur = () => close();
    document.addEventListener('contextmenu', fallback);
    document.addEventListener('mousedown', preserveSelection, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('fullscreenchange', blur);
    window.addEventListener('resize', blur);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('contextmenu', fallback);
      document.removeEventListener('mousedown', preserveSelection, true);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('fullscreenchange', blur);
      window.removeEventListener('resize', blur);
      window.removeEventListener('blur', blur);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const { offsetWidth, offsetHeight } = menuRef.current;
    setPosition({ x: Math.max(8, Math.min(menu.x, window.innerWidth - offsetWidth - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - offsetHeight - 8)) });
    menuRef.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); close(true); return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener('keydown', key, true);
    // Drop stale actions if their originating surface unmounts.
    const observer = new MutationObserver(() => { if (!menu.source.isConnected) close(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { document.removeEventListener('keydown', key, true); observer.disconnect(); };
  }, [menu, close]);

  const retained = presence.value;
  const select = (action: Pick<ContextMenuAction, 'onSelect'>) => {
    close(true);
    try { Promise.resolve(action.onSelect()).catch(() => showToast('Não foi possível concluir esta ação.')); }
    catch { showToast('Não foi possível concluir esta ação.'); }
  };
  return <MenuContext.Provider value={open}>
    {children}
    {retained && createPortal(<div ref={menuRef} role="menu" aria-label="Ações de contexto"
      className={`context-menu ${presence.closing ? 'dropdown-closing' : ''}`}
      inert={presence.closing} aria-hidden={presence.closing}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
      {retained.actions.map((action) => {
        const primary = <button key={action.id} type="button" role="menuitem"
        disabled={action.disabled} className={`${action.danger ? 'context-menu-danger' : ''} ${action.separator ? 'context-menu-separated' : ''}`}
        onClick={() => select(action)}>{action.icon && <span className="context-menu-icon">{action.icon}</span>}<span>{action.label}</span></button>;
        const secondary = action.secondary;
        return secondary ? <div key={action.id} className="context-menu-row" role="none">{primary}
          <Tooltip content={secondary.label}><button type="button" role="menuitem" aria-label={secondary.label}
            disabled={secondary.disabled} className={`context-menu-secondary ${secondary.danger ? 'context-menu-danger' : ''}`}
            onClick={() => select(secondary)}>{secondary.icon || secondary.label}</button></Tooltip>
        </div> : primary;
      })}
    </div>, document.fullscreenElement ?? document.body)}
  </MenuContext.Provider>;
}
