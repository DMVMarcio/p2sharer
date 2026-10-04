import { t } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RoomAppInstance } from './types';
import { RoomAppCard } from './RoomAppCard';

interface Props {
  instances: RoomAppInstance[];
  layoutMode: 'grid' | 'spotlight';
  featuredId?: string;
  layoutKey: string;
  rootRef: React.RefObject<HTMLDivElement | null>;
  slotsRef: React.RefObject<Map<string, HTMLDivElement>>;
}

interface Placement { left: number; top: number; width: number; height: number; clipPath: string }

export const PersistentRoomApps: React.FC<Props> = ({ instances, layoutMode, featuredId, layoutKey, rootRef, slotsRef }) => {
  useLocale();
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const previousRef = useRef('');

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const next: Record<string, Placement> = {};
    for (const instance of instances) {
      const role = layoutMode === 'grid' ? 'grid' : featuredId === `app:${instance.id}` ? 'featured' : 'tray';
      const slot = slotsRef.current.get(`${role}:${instance.id}`);
      if (!slot) continue;
      const rect = slot.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const viewport = slot.closest<HTMLElement>('.streams-grid-wrapper, .spotlight-featured-area, .spotlight-tray-strip');
      const bounds = viewport?.getBoundingClientRect() || rootRect;
      const clipTop = Math.max(0, bounds.top - rect.top);
      const clipRight = Math.max(0, rect.right - bounds.right);
      const clipBottom = Math.max(0, rect.bottom - bounds.bottom);
      const clipLeft = Math.max(0, bounds.left - rect.left);
      next[instance.id] = { left: rect.left - rootRect.left - root.clientLeft,
        top: rect.top - rootRect.top - root.clientTop, width: rect.width, height: rect.height,
        clipPath: `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)` };
    }
    const serialized = JSON.stringify(next);
    if (serialized !== previousRef.current) {
      previousRef.current = serialized;
      setPlacements(next);
    }
  }, [instances, layoutMode, featuredId, rootRef, slotsRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    slotsRef.current.forEach((slot) => observer.observe(slot));
    root.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    let frame = 0;
    const until = performance.now() + 460;
    const followTransition = () => {
      measure();
      if (performance.now() < until) frame = requestAnimationFrame(followTransition);
    };
    frame = requestAnimationFrame(followTransition);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [measure, layoutKey]);

  return <div className="room-app-layer" aria-label={t("message.791e1b0c7eaf")}>
    {instances.map((instance) => {
      const placement = placements[instance.id];
      const isFeatured = layoutMode === 'spotlight' && featuredId === `app:${instance.id}`;
      return <RoomAppCard key={instance.id} instance={instance} isFeatured={isFeatured}
        compact={!isFeatured} style={placement || { left: -10000, top: -10000, width: 1, height: 1,
          visibility: 'hidden', pointerEvents: 'none' }} />;
    })}
  </div>;
};
