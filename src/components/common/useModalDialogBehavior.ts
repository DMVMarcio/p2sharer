import { useEffect, useRef } from 'react';

/** Shared focus and dismissal behavior for standard dialogs and custom dialog layouts. */
export function useModalDialogBehavior(onClose: () => void, busy = false, closeOnOutside = false, active = true) {
  const cardRef = useRef<HTMLElement | null>(null);
  const options = useRef({ onClose, busy, closeOnOutside });
  options.current = { onClose, busy, closeOnOutside };
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (!card.hasAttribute('role')) card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.tabIndex = -1;
    if (!card.hasAttribute('aria-labelledby') && !card.hasAttribute('aria-label')) {
      const heading = card.querySelector('h2');
      if (heading) card.setAttribute('aria-label', heading.textContent ?? '');
    }
    const controls = () => Array.from(card.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(control => !control.closest('[inert]'));
    (card.querySelector<HTMLElement>('[data-autofocus]') ?? controls()[0] ?? card).focus();
    const isTop = () => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      return dialogs[dialogs.length - 1] === card;
    };
    const dismiss = () => { if (!options.current.busy) options.current.onClose(); };
    const key = (event: KeyboardEvent) => {
      if (!isTop()) return;
      // Portaled child menus own Escape and focus until they finish closing.
      if (document.querySelector('[role="menu"], [role="listbox"], .emoji-picker-popover') ||
          (event.target instanceof Element && event.target.closest('[role="combobox"][aria-expanded="true"]'))) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
      if (event.key === 'Tab') {
        const items = controls();
        const target = document.activeElement;
        if (!items.length) { event.preventDefault(); card.focus(); }
        else if (event.shiftKey && (target === items[0] || !card.contains(target))) {
          event.preventDefault(); items[items.length - 1].focus();
        } else if (!event.shiftKey && (target === items[items.length - 1] || !card.contains(target))) {
          event.preventDefault(); items[0].focus();
        }
      }
    };
    const outside = (event: MouseEvent) => {
      if (isTop() && options.current.closeOnOutside && event.target === card.parentElement) dismiss();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('mousedown', outside);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active]);
  return (node: HTMLElement | null) => { cardRef.current = node; };
}
