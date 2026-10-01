import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import { Check, ChevronDown } from 'lucide-react';
import { useDropdownPresence } from '../../hooks/useDropdownPresence';

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'> {
  value: string | number;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
}

/** Canonical single-value selector. Focus stays on the combobox, including inside modal traps. */
export function Select({ value, options, onValueChange, placeholder = 'Selecionar', className = '', disabled, onKeyDown, onBlur, ...props }: Props) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const presence = useDropdownPresence(open ? true : null);
  const selectedIndex = options.findIndex((option) => String(option.value) === String(value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [positioned, setPositioned] = useState(false);
  const [placement, setPlacement] = useState('bottom');
  const enabled = options.map((option, index) => !option.disabled ? index : -1).filter((index) => index >= 0);

  const close = () => { setOpen(false); searchRef.current.text = ''; };
  const show = () => {
    if (disabled || !enabled.length) return;
    window.dispatchEvent(new CustomEvent('p2sharer:select-open', { detail: listId }));
    setPositioned(false);
    setActiveIndex(options[selectedIndex]?.disabled ? enabled[0] : selectedIndex >= 0 ? selectedIndex : enabled[0]);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    close();
    triggerRef.current?.focus({ preventScroll: true });
    if (String(option.value) !== String(value)) onValueChange(String(option.value));
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !listRef.current?.contains(event.target as Node)) close();
    };
    const otherSelect = (event: Event) => { if ((event as CustomEvent).detail !== listId) close(); };
    const blur = () => close();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('p2sharer:select-open', otherSelect);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('p2sharer:select-open', otherSelect);
      window.removeEventListener('blur', blur);
    };
  }, [open, listId]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!open || !trigger || !list) return;
    let disposed = false;
    const update = async () => {
      const position = await computePosition(trigger, list, { strategy: 'fixed', placement: 'bottom-start',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8,
          apply({ availableHeight, availableWidth, rects, elements }) {
            elements.floating.style.maxHeight = `${Math.max(0, Math.min(280, availableHeight))}px`;
            elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
            elements.floating.style.minWidth = `${Math.min(rects.reference.width, Math.max(0, availableWidth))}px`;
          } })] });
      if (disposed) return;
      Object.assign(list.style, { left: `${position.x}px`, top: `${position.y}px` });
      setPlacement(position.placement.startsWith('top') ? 'top' : 'bottom');
      setPositioned(true);
    };
    const cleanup = autoUpdate(trigger, list, () => { void update(); });
    return () => { disposed = true; cleanup(); };
  }, [open, options]);

  useEffect(() => {
    if (open && positioned) listRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, positioned]);

  const move = (direction: number) => {
    const index = enabled.indexOf(activeIndex);
    setActiveIndex(enabled[(index + direction + enabled.length) % enabled.length]);
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled || !enabled.length) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { if (open) choose(activeIndex); return; }
    if (event.key === 'Enter' || event.key === ' ' && !searchRef.current.text) {
      event.preventDefault(); event.stopPropagation();
      if (open) choose(activeIndex); else show();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.altKey && event.key === 'ArrowUp' && open) { choose(activeIndex); return; }
      if (!open) show();
      if (event.key === 'Home') setActiveIndex(enabled[0]);
      else if (event.key === 'End') setActiveIndex(enabled[enabled.length - 1]);
      else if (open) move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const previous = now - searchRef.current.time < 700 ? searchRef.current.text : '';
      const text = previous + event.key.toLocaleLowerCase();
      searchRef.current = { text, time: now };
      const query = text.split('').every((letter) => letter === text[0]) ? text[0] : text;
      const start = open ? activeIndex : selectedIndex;
      const order = [...enabled.filter((index) => index > start), ...enabled.filter((index) => index <= start)];
      const match = order.find((index) => options[index].label.toLocaleLowerCase().startsWith(query));
      if (!open) show();
      searchRef.current = { text, time: now };
      if (match !== undefined) setActiveIndex(match);
    }
  };

  return <>
    <button {...props} ref={triggerRef} type="button" role="combobox" disabled={disabled}
      className={`app-select ${open ? 'is-open' : ''} ${className}`} aria-expanded={open} aria-haspopup="listbox"
      aria-controls={presence.value ? listId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      onKeyDown={keyboard} onBlur={(event) => { close(); onBlur?.(event); }}
      onClick={(event) => { event.stopPropagation(); if (open) close(); else show(); }}>
      <span className="app-select-value">{options[selectedIndex]?.label ?? placeholder}</span>
      <ChevronDown className="app-select-chevron" size={14} aria-hidden="true" />
    </button>
    {presence.value && createPortal(<div ref={listRef} id={listId} role="listbox"
      aria-label={props['aria-label'] ?? triggerRef.current?.labels?.[0]?.textContent ?? 'Opções'}
      className={`app-select-list ${presence.closing ? 'dropdown-closing' : ''}`}
      data-placement={placement} inert={presence.closing} aria-hidden={presence.closing}
      style={{ visibility: positioned ? 'visible' : 'hidden' }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      {options.map((option, index) => <div key={String(option.value)} id={`${listId}-${index}`} role="option"
        data-option-index={index} aria-selected={index === selectedIndex} aria-disabled={option.disabled || undefined}
        className={`app-select-option ${index === activeIndex ? 'is-active' : ''}`}
        onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
        onClick={(event) => { event.stopPropagation(); choose(index); }}>
        <span>{option.label}</span>{index === selectedIndex && <Check size={14} aria-hidden="true" />}
      </div>)}
    </div>, document.fullscreenElement ?? document.body)}
  </>;
}
