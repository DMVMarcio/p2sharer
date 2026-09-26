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
}) => {
  const tooltipId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    showTimeoutRef.current = setTimeout(() => {
      setIsOpen(true);
    }, showDelay);
  }, [clearTimers, disabled, content, showDelay]);

  const handleHide = useCallback(() => {
    clearTimers();
    hideTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
      setCoords(null);
    }, hideDelay);
  }, [clearTimers, hideDelay]);

  // Position measurement right after opening or DOM change
  useLayoutEffect(() => {
    if (isOpen) {
      calculatePosition();
    }
  }, [isOpen, content, calculatePosition]);

  // Handle window resize and document scroll to re-anchor tooltip
  useEffect(() => {
    if (!isOpen) return;

    const handleReposition = () => {
      calculatePosition();
    };

    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [isOpen, calculatePosition]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  // Clone child with ref and event handlers
  const handleTriggerRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    const childRef = (children as any).ref;
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
      handleShow();
      children.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      handleHide();
      children.props.onBlur?.(e);
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
