import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useId,
} from 'react';
import { createPortal } from 'react-dom';
import { calculateTooltipPosition } from './tooltip_utils';

export interface TooltipProps {
  /** The content to show inside the tooltip. If null or undefined, tooltip will not appear. */
  content: React.ReactNode;
  /** The trigger element (must be a valid React single element). */
  children: React.ReactElement<any>;
  /** Preferred placement: 'auto' (default), 'top', or 'bottom'. */
  placement?: 'auto' | 'top' | 'bottom';
  /** Extra CSS classes for the tooltip container (e.g. 'tooltip-compact', 'watchers-tooltip', 'bitrate-tooltip'). */
  tooltipClassName?: string;
  /** Whether the tooltip should have compact styling (defaults to true if content is string). */
  compact?: boolean;
  /** Whether the tooltip allows mouse hover inside (e.g. for scrolling a list). */
  interactive?: boolean;
  /** Delay before displaying the tooltip in ms (default: 80ms). */
  showDelay?: number;
  /** Delay before hiding the tooltip in ms (default: 100ms). */
  hideDelay?: number;
  /** Whether the tooltip is disabled. */
  disabled?: boolean;
  /** Callback fired when the tooltip visibility state changes. */
  onOpenChange?: (open: boolean) => void;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = 'auto',
  tooltipClassName = '',
  compact,
  interactive = false,
  showDelay = 80,
  hideDelay = 100,
  disabled = false,
  onOpenChange,
}) => {
  const tooltipId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [isArmed, setIsArmed] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerActivationRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const notifiedOpenRef = useRef(false);

  const isCompact = compact ?? (typeof content === 'string' && !tooltipClassName);

  const clearTimers = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    setIsArmed(false);
    setIsOpen(false);
    setCoords(null);
  }, [clearTimers]);

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    const { top, left } = calculateTooltipPosition({
      triggerRect,
      tooltipRect: { width: tooltipRect.width, height: tooltipRect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placement,
      padding: 8,
      gap: 6,
    });

    setCoords({ top, left });
  }, [placement]);

  const handleShow = useCallback(() => {
    if (disabled || !content) return;
    clearTimers();
    setIsArmed(true);
    showTimeoutRef.current = setTimeout(() => {
      setIsOpen(true);
    }, showDelay);
  }, [clearTimers, disabled, content, showDelay]);

  const handleHide = useCallback(() => {
    clearTimers();
    hideTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
      setIsArmed(false);
      setCoords(null);
    }, hideDelay);
  }, [clearTimers, hideDelay]);

  // Notify each transition exactly once, including disposal of an open tooltip.
  useEffect(() => {
    if (notifiedOpenRef.current !== isOpen) {
      notifiedOpenRef.current = isOpen;
      onOpenChangeRef.current?.(isOpen);
    }
  }, [isOpen]);

  useEffect(() => {
    if (disabled || !content) dismiss();
  }, [disabled, content, dismiss]);

  // Track input even while closed: returning focus from a pointer-opened dialog
  // must not be treated as keyboard navigation and reopen its trigger tooltip.
  useEffect(() => {
    const pointer = () => { pointerActivationRef.current = true; };
    const keyboard = () => { pointerActivationRef.current = false; };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('mousedown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('mousedown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
    };
  }, []);

  // Window exits and activation can bypass the trigger's mouseleave (native
  // dragging, portals, reparenting and focus changes). Cancel pending shows too.
  useEffect(() => {
    if (!isArmed) return;
    const insidePanel = (event: Event) => interactive && tooltipRef.current?.contains(event.target as Node | null);
    const activate = (event: Event) => {
      if (insidePanel(event)) return;
      pointerActivationRef.current = event.type === 'pointerdown' || event.type === 'mousedown';
      dismiss();
    };
    const click = (event: Event) => {
      if (insidePanel(event) && !(event.target instanceof Element && event.target.closest('button, a, [role="button"]'))) return;
      dismiss();
    };
    const focusOutside = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!triggerRef.current?.contains(target) && !tooltipRef.current?.contains(target)) dismiss();
    };
    const exit = (event: MouseEvent) => { if (!event.relatedTarget) dismiss(); };
    const visibility = () => { if (document.hidden) dismiss(); };
    const scroll = (event: Event) => {
      // Lists inside interactive tooltips can scroll without dismissing their panel.
      if (interactive && tooltipRef.current?.contains(event.target as Node | null)) return;
      dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      pointerActivationRef.current = false;
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', activate, true);
    document.addEventListener('mousedown', activate, true);
    document.addEventListener('click', click, true);
    document.addEventListener('contextmenu', dismiss, true);
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('mouseout', exit);
    document.addEventListener('mouseleave', dismiss);
    document.addEventListener('pointerleave', dismiss);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', activate, true);
      document.removeEventListener('mousedown', activate, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('contextmenu', dismiss, true);
      document.removeEventListener('focusin', focusOutside);
      document.removeEventListener('mouseout', exit);
      document.removeEventListener('mouseleave', dismiss);
      document.removeEventListener('pointerleave', dismiss);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('keydown', escape);
    };
  }, [isArmed, interactive, dismiss]);

  // Position measurement right after opening or DOM change
  useLayoutEffect(() => {
    if (isOpen) {
      calculatePosition();
    }
  }, [isOpen, content, calculatePosition]);

  // A trigger can move without a mouse event when a popup or layout changes.
  useEffect(() => {
    if (!isOpen) return;
    const anchor = triggerRef.current;
    const initial = anchor?.getBoundingClientRect();
    const layoutSize = { width: anchor?.offsetWidth, height: anchor?.offsetHeight };
    const screenPosition = { x: window.screenX, y: window.screenY };
    let frame: number;
    const checkAnchor = () => {
      const rect = anchor?.getBoundingClientRect();
      // A centered hover scale changes the painted bounds, not the layout anchor.
      // Still dismiss on real movement, layout resizing and native window movement.
      if (!anchor?.isConnected || !rect || !initial ||
        Math.abs((rect.x + rect.width / 2) - (initial.x + initial.width / 2)) > 0.5 ||
        Math.abs((rect.y + rect.height / 2) - (initial.y + initial.height / 2)) > 0.5 ||
        anchor.offsetWidth !== layoutSize.width || anchor.offsetHeight !== layoutSize.height ||
        window.screenX !== screenPosition.x || window.screenY !== screenPosition.y) {
        dismiss();
        return;
      }
      frame = requestAnimationFrame(checkAnchor);
    };
    frame = requestAnimationFrame(checkAnchor);
    return () => cancelAnimationFrame(frame);
  }, [isOpen, dismiss]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimers();
      if (notifiedOpenRef.current) {
        notifiedOpenRef.current = false;
        onOpenChangeRef.current?.(false);
      }
    };
  }, [clearTimers]);

  // Clone child with ref and event handlers
  const handleTriggerRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    const childRef = children.props.ref;
    if (typeof childRef === 'function') {
      childRef(node);
    } else if (childRef && 'current' in childRef) {
      childRef.current = node;
    }
  };

  const triggerElement = React.cloneElement(children, {
    ref: handleTriggerRef,
    onMouseEnter: (e: React.MouseEvent) => {
      handleShow();
      children.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      handleHide();
      children.props.onMouseLeave?.(e);
    },
    onFocus: (e: React.FocusEvent) => {
      if (!pointerActivationRef.current && (e.target as HTMLElement).matches(':focus-visible')) handleShow();
      children.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      handleHide();
      children.props.onBlur?.(e);
    },
    onPointerDown: (e: React.PointerEvent) => {
      pointerActivationRef.current = true;
      dismiss();
      children.props.onPointerDown?.(e);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      pointerActivationRef.current = false;
      if (e.key === 'Escape') dismiss();
      children.props.onKeyDown?.(e);
    },
    'aria-describedby': isOpen ? tooltipId : undefined,
  });

  const shouldRenderTooltip = isOpen && Boolean(content) && !disabled;

  return (
    <>
      {triggerElement}
      {shouldRenderTooltip &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className={`custom-tooltip custom-tooltip-portal ${isCompact ? 'tooltip-compact' : ''} ${
              interactive ? 'interactive' : ''
            } ${coords ? 'visible' : ''} ${tooltipClassName}`.trim()}
            style={{
              top: coords ? `${coords.top}px` : '-9999px',
              left: coords ? `${coords.left}px` : '-9999px',
            }}
            onMouseEnter={interactive ? clearTimers : undefined}
            onMouseLeave={interactive ? handleHide : undefined}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
};
