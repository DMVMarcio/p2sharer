export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface TooltipPositionOptions {
  triggerRect: RectLike;
  tooltipRect: SizeLike;
  viewport: SizeLike;
  placement?: 'auto' | 'top' | 'bottom';
  padding?: number;
  gap?: number;
}

export interface TooltipPositionResult {
  top: number;
  left: number;
  actualPlacement: 'top' | 'bottom';
}

/**
 * Calculates viewport-clamped coordinates for a floating tooltip,
 * preventing clipping at screen edges (left, right, top, bottom)
 * and avoiding collision with parent overflowing containers.
 */
export function calculateTooltipPosition({
  triggerRect,
  tooltipRect,
  viewport,
  placement = 'auto',
  padding = 8,
  gap = 6,
}: TooltipPositionOptions): TooltipPositionResult {
  // Horizontal centering over trigger
  let left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;

  // Horizontal boundary clamping: ensure tooltip never overflows left or right edge of viewport
  const maxLeft = Math.max(padding, viewport.width - tooltipRect.width - padding);
  if (left > maxLeft) {
    left = maxLeft;
  }
  if (left < padding) {
    left = padding;
  }

  // Vertical placement & collision detection
  const spaceBelow = viewport.height - triggerRect.bottom;
  const spaceAbove = triggerRect.top;

  const fitsBelow = spaceBelow >= tooltipRect.height + gap + padding;
  const fitsAbove = spaceAbove >= tooltipRect.height + gap + padding;

  let top: number;
  let actualPlacement: 'top' | 'bottom';

  if (placement === 'top') {
    if (fitsAbove || spaceAbove > spaceBelow) {
      top = triggerRect.top - tooltipRect.height - gap;
      actualPlacement = 'top';
    } else {
      top = triggerRect.bottom + gap;
      actualPlacement = 'bottom';
    }
  } else if (placement === 'bottom') {
    if (fitsBelow || spaceBelow >= spaceAbove) {
      top = triggerRect.bottom + gap;
      actualPlacement = 'bottom';
    } else {
      top = triggerRect.top - tooltipRect.height - gap;
      actualPlacement = 'top';
    }
  } else {
    // 'auto' placement
    if (fitsBelow) {
      top = triggerRect.bottom + gap;
      actualPlacement = 'bottom';
    } else if (fitsAbove) {
      top = triggerRect.top - tooltipRect.height - gap;
      actualPlacement = 'top';
    } else {
      if (spaceBelow >= spaceAbove) {
        top = triggerRect.bottom + gap;
        actualPlacement = 'bottom';
      } else {
        top = triggerRect.top - tooltipRect.height - gap;
        actualPlacement = 'top';
      }
    }
  }

  // Vertical boundary clamping: ensure tooltip never overflows top or bottom edge of viewport
  const maxTop = Math.max(padding, viewport.height - tooltipRect.height - padding);
  if (top > maxTop) {
    top = maxTop;
  }
  if (top < padding) {
    top = padding;
  }

  return { top, left, actualPlacement };
}
