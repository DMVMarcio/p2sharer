import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ChevronRight } from 'lucide-react';
import { useDropdownPresence } from '../../hooks/useDropdownPresence';
import { showToast } from '../../hooks/useToast';
import { captureTextEditing, TEXT_EDITOR_SELECTOR } from '../../core/text_editing';
import { getTextEditingActions } from './text_editing_actions';
import { Tooltip } from './Tooltip';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  tooltip?: string;
  /** Visual choices retain their accessible label without displaying text. */
  iconOnly?: boolean;
  disabled?: boolean;
  selected?: boolean;
  danger?: boolean;
  separator?: boolean;
  onSelect?: () => void | Promise<unknown>;
  submenu?: ContextMenuAction[];
  secondary?: Pick<ContextMenuAction, 'label' | 'icon' | 'disabled' | 'danger' | 'onSelect'>;
}

interface MenuState {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  source: HTMLElement;
  toggle?: boolean;
  layout?: 'grid';
  placement?: 'top-center';
}

type MenuEvent = { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number; currentTarget: EventTarget | null };
const MenuContext = createContext<(event: MenuEvent, actions: ContextMenuAction[], options?: { toggle?: boolean; layout?: 'grid'; placement?: 'top-center' }) => void>(() => {});
export const useContextMenu = () => useContext(MenuContext);

/** Feature menus defer editor targets to the central text editing menu. */
export function isContextMenuEditor(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(TEXT_EDITOR_SELECTOR));
}

export function ContextMenuProvider({ children, getActions = () => [] }: {
  children: ReactNode;
  getActions?: () => ContextMenuAction[];
}) {
  useLocale();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<{ id: string; actions: ContextMenuAction[]; parentRect: DOMRect } | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState({ x: 0, y: 0 });
  const presence = useDropdownPresence(menu);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const submenuButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const enabledButtons = (actions: ContextMenuAction[], map = buttonRefs.current) => actions.flatMap(action =>
    [map.get(action.id), map.get(`${action.id}:secondary`)]
  ).filter((button): button is HTMLButtonElement => Boolean(button && !button.disabled));
  const currentRef = useRef(menu);
  const actionsRef = useRef(getActions);
  currentRef.current = menu;
  actionsRef.current = getActions;
  const [position, setPosition] = useState({ x: 0, y: 0, arrow: 0 });
  const close = useCallback((restoreFocus = false) => {
    if (restoreFocus && currentRef.current?.source.isConnected) currentRef.current.source.focus({ preventScroll: true });
    setActiveSubmenu(null);
    setMenu(null);
  }, []);
  const open = useCallback((event: MenuEvent, actions: ContextMenuAction[], options?: { toggle?: boolean; layout?: 'grid'; placement?: 'top-center' }) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveSubmenu(null);
    const source = event.currentTarget instanceof HTMLElement ? event.currentTarget : document.body;
    if (options?.toggle && currentRef.current?.source === source) { close(true); return; }
    const bounds = source.getBoundingClientRect();
    setMenu(actions.length ? { actions, source, toggle: options?.toggle, layout: options?.layout, placement: options?.placement,
      x: event.clientX || bounds.left + Math.min(bounds.width / 2, 24),
      y: event.clientY || bounds.top + Math.min(bounds.height / 2, 24) } : null);
  }, [close]);

  const openActionSubmenu = useCallback((action: ContextMenuAction, element: HTMLElement) => {
    if (!action.submenu?.length || action.disabled) return;
    const parentRect = element.getBoundingClientRect();
    let x = parentRect.right - 2;
    if (x + 190 > window.innerWidth - 8) x = Math.max(8, parentRect.left - 190 + 2);
    const y = Math.max(8, Math.min(parentRect.top - 4, window.innerHeight - 100));
    setSubmenuPosition({ x, y });
    setActiveSubmenu({ id: action.id, actions: action.submenu, parentRect });
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
      const actions: ContextMenuAction[] = selection ? [{ id: 'copy-selection', get label() { return t("message.73c01cc8056b"); }, icon: <Copy size={15} />,
        onSelect: () => navigator.clipboard.writeText(selection) }] : [];
      // Modal backgrounds must not expose actions belonging to the room behind them.
      if (!(event.target instanceof Element && event.target.closest('.modal-overlay, [role="dialog"], [role="alertdialog"]'))) actions.push(...actionsRef.current());
      open(event, actions);
    };
    const dismiss = (event: PointerEvent) => {
      if (currentRef.current?.toggle && currentRef.current.source.contains(event.target as Node)) return;
      if (!menuRef.current?.contains(event.target as Node) && !submenuRef.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node) && !submenuRef.current?.contains(event.target as Node)) close();
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
    const source = menu.source.getBoundingClientRect();
    const x = menu.placement === 'top-center' ? source.left + source.width / 2 - offsetWidth / 2 : menu.x;
    const y = menu.placement === 'top-center' ? source.top - offsetHeight - 12 : menu.y;
    const left = Math.max(8, Math.min(x, window.innerWidth - offsetWidth - 8));
    setPosition({ x: left, y: Math.max(8, Math.min(y, window.innerHeight - offsetHeight - 8)),
      arrow: Math.max(10, Math.min(offsetWidth - 10, source.left + source.width / 2 - left)) });
    enabledButtons(menu.actions)[0]?.focus({ preventScroll: true });
  }, [menu]);

  useLayoutEffect(() => {
    if (!activeSubmenu || !submenuRef.current) return;
    const { offsetWidth, offsetHeight } = submenuRef.current;
    const { parentRect } = activeSubmenu;
    let x = parentRect.right - 2;
    if (x + offsetWidth > window.innerWidth - 8) {
      x = Math.max(8, parentRect.left - offsetWidth + 2);
    }
    let y = parentRect.top - 4;
    if (y + offsetHeight > window.innerHeight - 8) {
      y = Math.max(8, window.innerHeight - offsetHeight - 8);
    }
    setSubmenuPosition({ x, y });
  }, [activeSubmenu]);

  useEffect(() => {
    if (!menu) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        if (activeSubmenu) {
          const parentBtn = buttonRefs.current.get(activeSubmenu.id);
          setActiveSubmenu(null);
          parentBtn?.focus();
        } else {
          close(true);
        }
        return;
      }

      if (activeSubmenu && submenuRef.current?.contains(document.activeElement)) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation();
          const parentBtn = buttonRefs.current.get(activeSubmenu.id);
          setActiveSubmenu(null);
          parentBtn?.focus();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = enabledButtons(activeSubmenu.actions, submenuButtonRefs.current);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return;
      }

      if (event.key === 'ArrowRight') {
        const currentAction = menu.actions.find(a => buttonRefs.current.get(a.id) === document.activeElement);
        if (currentAction?.submenu?.length) {
          event.preventDefault(); event.stopPropagation();
          const btn = buttonRefs.current.get(currentAction.id);
          if (btn) {
            openActionSubmenu(currentAction, btn);
            requestAnimationFrame(() => {
              const subButtons = enabledButtons(currentAction.submenu!, submenuButtonRefs.current);
              subButtons[0]?.focus();
            });
          }
          return;
        }
      }

      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', ...(menu.layout === 'grid' ? ['ArrowLeft', 'ArrowRight'] : [])].includes(event.key)) return;
      event.preventDefault();
      setActiveSubmenu(null);
      const buttons = enabledButtons(menu.actions);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener('keydown', key, true);
    // Drop stale actions if their originating surface unmounts.
    const observer = new MutationObserver(() => { if (!menu.source.isConnected) close(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { document.removeEventListener('keydown', key, true); observer.disconnect(); };
  }, [menu, activeSubmenu, close, openActionSubmenu]);

  const retained = presence.value;
  const select = (action: Pick<ContextMenuAction, 'onSelect'>) => {
    if (!action.onSelect) return;
    close(true);
    try { Promise.resolve(action.onSelect()).catch(() => showToast(t("message.1776fea88e1f"), 3500, 'error')); }
    catch { showToast(t("message.1776fea88e1f"), 3500, 'error'); }
  };
  return <MenuContext.Provider value={open}>
    {children}
    {retained && createPortal(<div ref={menuRef} role="menu" aria-label={t("message.392b6906f80e")}
      className={`context-menu ${retained.layout === 'grid' ? 'context-menu-visual-grid' : ''} ${retained.placement === 'top-center' ? 'context-menu-anchored-above' : ''} ${presence.closing ? 'dropdown-closing' : ''}`}
      inert={presence.closing} aria-hidden={presence.closing}
      style={{ left: position.x, top: position.y, '--context-menu-arrow-left': `${position.arrow}px` } as CSSProperties}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
      {retained.actions.map((action) => {
        const hasSubmenu = Boolean(action.submenu?.length);
        const trailingIcon = action.trailingIcon || (hasSubmenu ? <ChevronRight size={13} /> : undefined);
        const tooltipText = action.tooltip ?? (action.iconOnly ? action.label : undefined);
        const primary = <button key={action.id} type="button" role={action.selected === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={action.selected}
          aria-haspopup={hasSubmenu ? 'menu' : undefined}
          aria-expanded={hasSubmenu ? activeSubmenu?.id === action.id : undefined}
          ref={element => { if (element) buttonRefs.current.set(action.id, element); else buttonRefs.current.delete(action.id); }}
          aria-label={tooltipText}
          disabled={action.disabled}
          className={`${action.iconOnly ? 'context-menu-visual-choice' : ''} ${action.danger ? 'context-menu-danger' : ''} ${action.separator ? 'context-menu-separated' : ''}`}
          onPointerEnter={(event) => {
            if (hasSubmenu) openActionSubmenu(action, event.currentTarget);
            else setActiveSubmenu(null);
          }}
          onClick={(event) => {
            if (hasSubmenu) {
              openActionSubmenu(action, event.currentTarget);
              return;
            }
            if (action.onSelect) select(action as Pick<ContextMenuAction, 'onSelect'>);
          }}>
          {action.icon && <span className="context-menu-icon" aria-hidden="true">{action.icon}</span>}
          {!action.iconOnly && <span className="context-menu-label">{action.label}</span>}
          {trailingIcon && <span className="context-menu-trailing-icon" aria-hidden="true">{trailingIcon}</span>}
        </button>;
        const primaryAction = tooltipText
          ? <Tooltip key={action.id} content={tooltipText} placement={retained.placement === 'top-center' || action.iconOnly ? 'top' : 'auto'} disabled={presence.closing}>{primary}</Tooltip>
          : primary;
        const secondary = action.secondary;
        return secondary ? <div key={action.id} className="context-menu-row" role="none">{primaryAction}
          <Tooltip content={secondary.label} disabled={presence.closing}><button type="button" role="menuitem" aria-label={secondary.label}
            ref={element => { const id = `${action.id}:secondary`; if (element) buttonRefs.current.set(id, element); else buttonRefs.current.delete(id); }}
            disabled={secondary.disabled} className={`context-menu-secondary ${secondary.danger ? 'context-menu-danger' : ''}`}
            onClick={() => select(secondary)}>{secondary.icon || secondary.label}</button></Tooltip>
        </div> : primaryAction;
      })}
    </div>, document.fullscreenElement ?? document.body)}
    {activeSubmenu && createPortal(
      <div ref={submenuRef} role="menu" aria-label={t("message.392b6906f80e")}
        className="context-menu context-submenu"
        style={{ left: submenuPosition.x, top: submenuPosition.y } as CSSProperties}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
        {activeSubmenu.actions.map((subAction) => {
          const tooltipText = subAction.tooltip ?? (subAction.iconOnly ? subAction.label : undefined);
          const primary = <button key={subAction.id} type="button"
            role={subAction.selected === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={subAction.selected}
            ref={element => { if (element) submenuButtonRefs.current.set(subAction.id, element); else submenuButtonRefs.current.delete(subAction.id); }}
            aria-label={tooltipText}
            disabled={subAction.disabled}
            className={`${subAction.iconOnly ? 'context-menu-visual-choice' : ''} ${subAction.danger ? 'context-menu-danger' : ''} ${subAction.separator ? 'context-menu-separated' : ''}`}
            onClick={() => { if (subAction.onSelect) select(subAction as Pick<ContextMenuAction, 'onSelect'>); }}>
            {subAction.icon && <span className="context-menu-icon" aria-hidden="true">{subAction.icon}</span>}
            {!subAction.iconOnly && <span className="context-menu-label">{subAction.label}</span>}
            {subAction.trailingIcon && <span className="context-menu-trailing-icon" aria-hidden="true">{subAction.trailingIcon}</span>}
          </button>;
          return tooltipText
            ? <Tooltip key={subAction.id} content={tooltipText} placement="auto">{primary}</Tooltip>
            : primary;
        })}
      </div>,
      document.fullscreenElement ?? document.body
    )}
  </MenuContext.Provider>;
}
