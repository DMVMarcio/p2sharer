import { Fragment, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Globe, Plus, X } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { useListPresence } from '../hooks/useListPresence';
import { t } from '../i18n';
import { BROWSER_HOME, type BrowserCommand, type BrowserTab } from './browser_protocol';

function BrowserFavicon({ value }: { value?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [value]);
  return value && !failed ? <img className="browser-favicon" src={value} alt="" draggable={false} onError={() => setFailed(true)} /> : <Globe size={13} />;
}

export function BrowserTabs({ tabs, active, canControl, running, command }: {
  tabs: BrowserTab[]; active: number; canControl: boolean; running: boolean; command: (command: BrowserCommand) => void;
}) {
  const entries = useListPresence(tabs);
  const row = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; active: boolean; before: number | null; width: number; height: number;
    offsetX: number; offsetY: number; targets: { id: number; center: number }[] } | null>(null);
  const suppressClick = useRef(false);
  const [drop, setDrop] = useState<{ id: number; before: number | null; left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const focused = document.activeElement?.closest<HTMLElement>('[data-browser-tab]');
    if (focused && row.current?.contains(focused) && !tabs.some(tab => tab.id === Number(focused.dataset.browserTab)))
      row.current.querySelector<HTMLButtonElement>(`[data-browser-tab="${active}"] .browser-tab-label`)?.focus({ preventScroll: true });
  }, [tabs, active]);
  useEffect(() => { if (!canControl || drag.current && !tabs.some(tab => tab.id === drag.current?.id)) { drag.current = null; setDrop(null); } }, [canControl, tabs]);
  useEffect(() => {
    const cancel = () => { drag.current = null; setDrop(null); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && drag.current?.active) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener('blur', cancel); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key, true); };
  }, []);
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current; if (!current || !canControl) return;
    if (!current.active && Math.abs(event.clientX - current.x) < 5) return;
    current.active = true; suppressClick.current = true; event.preventDefault();
    const bounds = row.current!.getBoundingClientRect();
    if (event.clientX < bounds.left + 20) row.current!.scrollLeft -= 16;
    else if (event.clientX > bounds.right - 20) row.current!.scrollLeft += 16;
    current.before = current.targets.find(target => event.clientX - bounds.left + row.current!.scrollLeft < target.center)?.id ?? null;
    setDrop({ id: current.id, before: current.before, left: event.clientX - current.offsetX, top: event.clientY - current.offsetY,
      width: current.width, height: current.height });
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const current = drag.current; drag.current = null; setDrop(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && canControl && current?.active) command({ kind: 'move-tab', id: current.id, before: current.before });
  };
  const dragged = tabs.find(tab => tab.id === drop?.id);
  const placeholder = drop && <div className="browser-tab-placeholder" aria-hidden="true" style={{ width: drop.width, height: drop.height }} />;
  return <><div ref={row} className={`browser-tabs${drop ? ' reordering' : ''}`} role="group" aria-label={t('browser.tabs')}>
    {entries.map(({ item: tab, entering, exiting }) => <Fragment key={tab.id}>
      {drop?.before === tab.id && placeholder}
      <div data-browser-tab={tab.id} inert={exiting} aria-hidden={exiting || undefined}
      className={`browser-tab-slot${entering ? ' entering' : ''}${exiting ? ' exiting' : ''}${drop?.id === tab.id ? ' dragging' : ''}`}>
      <div className={`browser-tab${tab.id === active ? ' selected' : ''}`}>
        <button aria-pressed={tab.id === active} className="btn btn-secondary btn-sm browser-tab-label" disabled={!canControl || exiting}
          onAuxClick={event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); if (canControl && !exiting) command({ kind: 'close-tab', id: tab.id }); } }}
          onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
          onPointerDown={event => { if (event.button !== 0 || !canControl) return; suppressClick.current = false;
            const slot = event.currentTarget.closest<HTMLElement>('[data-browser-tab]')!; const bounds = slot.getBoundingClientRect();
            const rowBounds = row.current!.getBoundingClientRect();
            const targets = [...row.current!.querySelectorAll<HTMLElement>('[data-browser-tab]')].filter(item => item !== slot && !item.hasAttribute('inert')).map(item => {
              const box = item.getBoundingClientRect(); return { id: Number(item.dataset.browserTab),
                center: box.left - rowBounds.left + row.current!.scrollLeft + box.width / 2 - (box.left > bounds.left ? bounds.width + 4 : 0) };
            });
            drag.current = { id: tab.id, x: event.clientX, active: false, before: null, width: bounds.width, height: bounds.height,
              offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top, targets }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
          onKeyDown={event => {
            suppressClick.current = false;
            if (!event.ctrlKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); const index = tabs.findIndex(item => item.id === tab.id);
            if (event.key === 'ArrowLeft' && index > 0) command({ kind: 'move-tab', id: tab.id, before: tabs[index - 1].id });
            if (event.key === 'ArrowRight' && index < tabs.length - 1) command({ kind: 'move-tab', id: tab.id, before: tabs[index + 2]?.id ?? null });
          }} onClick={() => { if (!suppressClick.current) command({ kind: 'select-tab', id: tab.id }); }}>
          <BrowserFavicon value={tab.favicon} /><span>{tab.title || t('browser.newTab')}</span>
        </button>
        <TooltipButton className="btn btn-secondary btn-sm browser-tab-close" tooltip={t('browser.closeTab')} disabled={!canControl || exiting}
          onClick={() => command({ kind: 'close-tab', id: tab.id })}><X size={13} /></TooltipButton>
      </div>
    </div></Fragment>)}
    {drop && drop.before === null && placeholder}
    {running && <TooltipButton className="btn btn-secondary btn-sm" tooltip={t('browser.newTab')} disabled={!canControl || tabs.length >= 16}
      onClick={() => command({ kind: 'new-tab', url: BROWSER_HOME })}><Plus size={15} /></TooltipButton>}
  </div>{drop && dragged && createPortal(<div className="browser-tab browser-tab-preview selected" aria-hidden="true"
    style={{ left: drop.left, top: drop.top, width: drop.width, height: drop.height }}>
    <div className="btn btn-secondary btn-sm browser-tab-label"><BrowserFavicon value={dragged.favicon} /><span>{dragged.title || t('browser.newTab')}</span></div>
    <X className="browser-tab-preview-close" size={13} />
  </div>, document.body)}</>;
}
