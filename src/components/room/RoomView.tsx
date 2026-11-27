import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useRef, useState } from 'react';
import { usePanelSize } from '../../hooks/ui/usePanelSize';
import { PanelResizeHandle } from '../common/PanelResizeHandle';
import { UnreadChatBadge } from './UnreadChatBadge';
import { StreamHeaderBar } from './StreamHeaderBar';
import { RoomVideoContainer } from './RoomVideoContainer';
import { RoomSidebar } from './RoomSidebar';
import { MobileRoomDock } from './MobileRoomDock';
import { ChatFileRequests } from './ChatFileRequests';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';
import { useIsMobile } from '../../hooks/ui/useIsMobile';
import { stateStore } from '../../core/state_store';
import { TooltipButton } from '../common/TooltipButton';
import { AlertTriangle, Plus, X } from 'lucide-react';

export const RoomView: React.FC = () => {
  useLocale();
  const { isSidebarCollapsed, toggleSidebar, unreadChatMessages, isWaitingForAdmission, isAdmitterOnline, connectingOverlay } = useRoom();
  const { openModal } = useModal();
  const layoutRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const sidebarSize = usePanelSize(layoutRef, 'width', 'p2sharer_sidebar_width', 320, 240, 240, !isMobile);
  const [waitingHostDismissed, setWaitingHostDismissed] = useState(false);

  useEffect(() => {
    if (!isWaitingForAdmission || isAdmitterOnline) {
      setWaitingHostDismissed(false);
    }
  }, [isWaitingForAdmission, isAdmitterOnline]);

  useEffect(() => {
    if (isMobile) {
      stateStore.set((s) => { s.isSidebarCollapsed = true; });
    }
  }, [isMobile]);

  useEffect(() => {
    const container = layoutRef.current;
    if (!container || isMobile) return;

    let isNearby = false;
    let rafId: number | null = null;

    const onPointerMove = (e: PointerEvent) => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const edge = edgeRef.current;
        if (!edge) return;
        const rect = edge.getBoundingClientRect();
        const inZone = (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        );
        if (inZone !== isNearby) {
          isNearby = inZone;
          edge.classList.toggle('is-nearby', inZone);
        }
      });
    };

    const onPointerLeave = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (isNearby) {
        isNearby = false;
        edgeRef.current?.classList.remove('is-nearby');
      }
    };

    container.addEventListener('pointermove', onPointerMove, { passive: true });
    container.addEventListener('pointerleave', onPointerLeave, { passive: true });
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      edgeRef.current?.classList.remove('is-nearby');
    };
  }, [isMobile]);

  return (
    <section className="view active" id="view-group-room">
      <div
        className={`room-layout ${isMobile ? 'is-mobile' : ''}`}
        id="room-layout-container"
        ref={layoutRef}
        style={!isMobile ? ({ '--room-sidebar-width': `${sidebarSize.size}px` } as React.CSSProperties) : undefined}
      >
        <div className="stream-area">
          <StreamHeaderBar />
          {isWaitingForAdmission && !isAdmitterOnline && !connectingOverlay.visible && !waitingHostDismissed && (
            <div className="room-waiting-host-banner" role="status" aria-live="polite">
              <div className="room-waiting-host-banner-copy">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{t('room.waitingHostBanner')}</span>
              </div>
              <div className="room-waiting-host-banner-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => openModal('createRoom')}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{t('room.waitingHostCreateAction')}</span>
                </button>
                <TooltipButton
                  className="btn-icon-header room-waiting-host-dismiss"
                  tooltip={t('room.dismissWaitingHostBanner')}
                  aria-label={t('room.dismissWaitingHostBanner')}
                  onClick={() => setWaitingHostDismissed(true)}
                >
                  <X size={14} aria-hidden="true" />
                </TooltipButton>
              </div>
            </div>
          )}
          <RoomVideoContainer />
          <MobileRoomDock />
        </div>

        {/* Hoverable lateral sidebar toggle arrow (Desktop only) */}
        {!isMobile && (
          <div
            ref={edgeRef}
            className={`sidebar-toggle-edge ${isSidebarCollapsed ? 'collapsed' : 'expanded'} ${unreadChatMessages > 0 ? 'has-unread' : ''}`}
          >
            <button
              type="button"
              className="sidebar-edge-toggle-btn"
              id="btn-sidebar-edge-toggle"
              onClick={toggleSidebar}
              aria-expanded={!isSidebarCollapsed}
              aria-controls="room-sidebar"
              aria-label={isSidebarCollapsed ? t("message.86d416fc47cf") : t("message.182641374267")}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {isSidebarCollapsed ? (
                  <polyline points="15 18 9 12 15 6" />
                ) : (
                  <polyline points="9 18 15 12 9 6" />
                )}
              </svg>
              {isSidebarCollapsed && <UnreadChatBadge count={unreadChatMessages} />}
            </button>
          </div>
        )}

        {/* Backdrop for drawer sidebar on mobile / overlay */}
        <div
          className={`room-sidebar-backdrop ${!isSidebarCollapsed ? 'visible' : ''}`}
          onClick={toggleSidebar}
          aria-hidden="true"
        />

        {!isSidebarCollapsed && !isMobile && (
          <PanelResizeHandle
            axis="width"
            label={t('layout.resizeChat')}
            controls="room-sidebar"
            {...sidebarSize}
          />
        )}
        <RoomSidebar />
      </div>
      <ChatFileRequests />
    </section>
  );
};
