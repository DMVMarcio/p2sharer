import { useEffect, useRef, useState, type PointerEvent } from 'react';
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
  const drag = useRef<{ id: number; x: number; active: boolean; before: number | null } | null>(null);
  const suppressClick = useRef(false);
  const [drop, setDrop] = useState<{ id: number; before: number | null } | null>(null);
  useEffect(() => {
    const focused = document.activeElement?.closest<HTMLElement>('[data-browser-tab]');
    if (focused && row.current?.contains(focused) && !tabs.some(tab => tab.id === Number(focused.dataset.browserTab)))
      row.current.querySelector<HTMLButtonElement>(`[data-browser-tab="${active}"] .browser-tab-label`)?.focus({ preventScroll: true });
  }, [tabs, active]);
  useEffect(() => { if (!canControl || drag.current && !tabs.some(tab => tab.id === drag.current?.id)) { drag.current = null; setDrop(null); } }, [canControl, tabs]);
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current; if (!current || !canControl) return;
    if (!current.active && Math.abs(event.clientX - current.x) < 5) return;
    current.active = true; suppressClick.current = true; event.preventDefault();
    const bounds = row.current!.getBoundingClientRect();
    if (event.clientX < bounds.left + 20) row.current!.scrollLeft -= 16;
    else if (event.clientX > bounds.right - 20) row.current!.scrollLeft += 16;
    const targets = [...row.current!.querySelectorAll<HTMLElement>('[data-browser-tab]')].filter(element => Number(element.dataset.browserTab) !== current.id && !element.hasAttribute('inert'));
    current.before = Number(targets.find(element => { const bounds = element.getBoundingClientRect(); return event.clientX < bounds.left + bounds.width / 2; })?.dataset.browserTab) || null;
    setDrop({ id: current.id, before: current.before });
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const current = drag.current; drag.current = null; setDrop(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && canControl && current?.active) command({ kind: 'move-tab', id: current.id, before: current.before });
  };
  return <div ref={row} className={`browser-tabs${drop ? ' reordering' : ''}`} role="group" aria-label={t('browser.tabs')}>
    {entries.map(({ item: tab, entering, exiting }) => <div data-browser-tab={tab.id} key={tab.id} inert={exiting} aria-hidden={exiting || undefined}
      className={`browser-tab-slot${entering ? ' entering' : ''}${exiting ? ' exiting' : ''}${drop?.before === tab.id ? ' drop-before' : ''}${drop?.id === tab.id ? ' dragging' : ''}`}>
      <div className={`browser-tab${tab.id === active ? ' selected' : ''}`}>
        <button aria-pressed={tab.id === active} className="btn btn-secondary btn-sm browser-tab-label" disabled={!canControl || exiting}
          onPointerDown={event => { if (event.button !== 0 || !canControl) return; suppressClick.current = false;
            drag.current = { id: tab.id, x: event.clientX, active: false, before: null }; event.currentTarget.setPointerCapture(event.pointerId); }}
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
    </div>)}
    {drop && drop.before === null && <span className="browser-tab-drop-end" aria-hidden="true" />}
    {running && <TooltipButton className="btn btn-secondary btn-sm" tooltip={t('browser.newTab')} disabled={!canControl || tabs.length >= 16}
      onClick={() => command({ kind: 'new-tab', url: BROWSER_HOME })}><Plus size={15} /></TooltipButton>}
  </div>;
}
