import { useEffect, type RefObject } from 'react';
import { useContextMenu, type ContextMenuAction } from '../components/common/ContextMenu';
import { t } from '../i18n';
import type { BrowserModel } from './browser_model';
import { BROWSER_WIDTH, BROWSER_HEIGHT } from './browser_protocol';

export function BrowserContextMenu({ model, surface }: { model: BrowserModel | undefined; surface: RefObject<HTMLDivElement | null> }) {
  const open = useContextMenu();
  const menu = model?.contextMenu;
  useEffect(() => {
    const element = surface.current;
    if (!menu || !model?.canControl || menu.tab !== model.state.active || !element) return;
    model.contextMenu = null;
    const tab = menu.tab;
    const send: BrowserModel['command'] = command => { if (model.canControl && model.state.active === tab) model.command(command); };
    const bounds = element.getBoundingClientRect();
    const scale = Math.min(bounds.width / BROWSER_WIDTH, bounds.height / BROWSER_HEIGHT);
    const actions: ContextMenuAction[] = ['back', 'forward', 'reload'].map(kind => ({
      id: kind, label: t(`browser.${kind}`), onSelect: () => send({ kind: kind as 'back' | 'forward' | 'reload' })
    }));
    for (const [kind, url] of [['link', menu.link], ['source', menu.source]]) {
      if (!url) continue;
      actions.push({ id: `open-${kind}`, label: t(`browser.context.open.${kind}`), onSelect: () => send({ kind: 'new-tab', url }) });
      actions.push({ id: `copy-${kind}`, label: t(`browser.context.copy.${kind}`), onSelect: () => navigator.clipboard.writeText(url) });
    }
    if (menu.selection) actions.push({ id: 'copy', label: t('browser.context.copyText'), onSelect: () => navigator.clipboard.writeText(menu.selection) });
    if (menu.editable) {
      const key = (key: string, code: string, virtual_key: number, modifiers = 0) => {
        send({ kind: 'key', event: 'keyDown', key, code, virtual_key, modifiers });
        send({ kind: 'key', event: 'keyUp', key, code, virtual_key, modifiers });
      };
      if (menu.selection) actions.push({ id: 'cut', label: t('browser.context.cut'), onSelect: async () => {
        await navigator.clipboard.writeText(menu.selection); key('Delete', 'Delete', 46);
      } });
      actions.push({ id: 'paste', label: t('browser.context.paste'), onSelect: async () => {
        const text = await navigator.clipboard.readText(); if (text) send({ kind: 'text', text: text.slice(0, 4096) });
      } });
      actions.push({ id: 'select-all', label: t('browser.context.selectAll'), onSelect: () => key('a', 'KeyA', 65, 2) });
    }
    open({ currentTarget: element, clientX: bounds.left + (bounds.width - BROWSER_WIDTH * scale) / 2 + menu.x * scale,
      clientY: bounds.top + (bounds.height - BROWSER_HEIGHT * scale) / 2 + menu.y * scale,
      preventDefault() {}, stopPropagation() {} }, actions);
  }, [menu, model, open, surface]);
  return null;
}
