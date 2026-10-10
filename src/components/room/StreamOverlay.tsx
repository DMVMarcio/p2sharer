import { Nickname } from '../common/Nickname';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useRef, useState } from 'react';
import { clampOverlay, snapOverlay, resizeOverlay, type OverlayCorner, type OverlayPosition } from '../../core/media_streams';
import type { RoomSlotInfo } from '../../core/types';
import { roomService } from '../../services/room_service';
import { stateStore } from '../../core/state_store';
import { TooltipButton } from '../common/TooltipButton';
import { useContextMenu } from '../common/ContextMenu';
import { X } from 'lucide-react';
import './stream_overlays.css';

interface Props { slot: RoomSlotInfo; target: string; index: number }
let overlayOrder = 100;

export function StreamOverlay({ slot, target, index }: Props) {
  useLocale();
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const openContextMenu = useContextMenu();
  const positionKey = `${target}:${slot.peerId}`;
  const [position, setPosition] = useState<OverlayPosition>(() => stateStore.overlayPositions[positionKey] ||
    { x: 0.72, y: Math.max(0, 0.72 - index * 0.24), width: 0.26 });
  const [moving, setMoving] = useState(false);
  const gesture = useRef<{ x: number; y: number; position: OverlayPosition; corner?: OverlayCorner } | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [order, setOrder] = useState(20 + index);
  useEffect(() => { stateStore.overlayPositions[positionKey] = position; }, [positionKey, position]);

  useEffect(() => {
    const parent = frameRef.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      const bounds = parent.getBoundingClientRect();
      if (bounds.width && bounds.height) setPosition((current) => clampOverlay(current, aspect, bounds.width / bounds.height, inset(bounds)));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [aspect]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !slot.stream) return;
    video.srcObject = slot.stream;
    void video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [slot.stream]);

  const geometry = () => {
    const bounds = frameRef.current?.parentElement?.getBoundingClientRect();
    return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
  };
  const inset = (bounds: DOMRect) => ({ x: Math.min(0.04, 12 / bounds.width), y: Math.min(0.04, 12 / bounds.height) });
  const start = (event: React.PointerEvent, corner?: OverlayCorner) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    frameRef.current?.setPointerCapture(event.pointerId);
    gesture.current = { x: event.clientX, y: event.clientY, position, corner };
    setOrder(++overlayOrder);
    setMoving(true);
  };
  const move = (event: React.PointerEvent) => {
    const current = gesture.current;
    const bounds = geometry();
    if (!current || !bounds) return;
    event.stopPropagation();
    const dx = (event.clientX - current.x) / bounds.width;
    const dy = (event.clientY - current.y) / bounds.height;
    const next = current.corner ? resizeOverlay(current.position, current.corner, dx, dy, aspect, bounds.width / bounds.height, inset(bounds)) :
      { ...current.position, x: current.position.x + dx, y: current.position.y + dy };
    setPosition(clampOverlay(next, aspect, bounds.width / bounds.height, inset(bounds)));
  };
  const finish = (event: React.PointerEvent) => {
    if (!gesture.current) return;
    event.stopPropagation();
    gesture.current = null;
    setMoving(false);
    const bounds = geometry();
    if (bounds) setPosition((current) => snapOverlay(current, aspect, bounds.width / bounds.height, inset(bounds)));
  };
  const remove = () => roomService.removeOverlay(target, slot.peerId);

  return <div ref={frameRef} className={`stream-overlay ${moving ? 'is-moving' : ''}`} style={{
    left: `${position.x * 100}%`, top: `${position.y * 100}%`, width: `${position.width * 100}%`, aspectRatio: aspect,
    zIndex: order,
  }} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
    onLostPointerCapture={finish} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
    onContextMenu={(event) => openContextMenu(event, [{ id: 'remove-overlay', get label() { return t("message.4f3ceac0cb5c"); }, onSelect: remove }])}
    tabIndex={0} aria-label={t("message.79d5eedaf833", { v0: slot.senderName })}
    onKeyDown={(event) => {
      if (event.key === 'Delete' || event.key === 'Escape') { event.stopPropagation(); remove(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = geometry();
      if (!bounds) return;
      setPosition((current) => clampOverlay({ x: current.x + (event.key === 'ArrowLeft' ? -0.04 : event.key === 'ArrowRight' ? 0.04 : 0),
        y: current.y + (event.key === 'ArrowUp' ? -0.04 : event.key === 'ArrowDown' ? 0.04 : 0),
        width: current.width + (event.key === '-' ? -0.02 : ['+', '='].includes(event.key) ? 0.02 : 0) }, aspect, bounds.width / bounds.height, inset(bounds)));
    }}>
    {slot.stream ? <video ref={videoRef} autoPlay playsInline muted onLoadedMetadata={() => {
      const video = videoRef.current;
      if (video?.videoWidth && video.videoHeight) setAspect(video.videoWidth / video.videoHeight);
    }} /> : <div className="stream-overlay-loading">{t("message.744a6cf3f2d0")}</div>}
    <div className="stream-overlay-toolbar"><ProfileAvatar peerId={slot.ownerPeerId ?? slot.peerId} name={slot.senderName}
      isLocal={slot.isLocal} color={slot.color} className="stream-profile-avatar" />
      <span><Nickname name={slot.senderName} peerId={slot.ownerPeerId ?? slot.peerId} isLocal={slot.isLocal} /> · {slot.mediaLabel || t("message.bc10c86c24b5")}</span>
      <TooltipButton tooltip={t("message.4f3ceac0cb5c")} className="btn btn-sm btn-outline" aria-label={t("message.4f3ceac0cb5c")} onClick={remove}><X size={14} /></TooltipButton>
    </div>
    {(['nw', 'ne', 'sw', 'se'] as const).map(corner => <div key={corner} className={`stream-overlay-resize ${corner}`} onPointerDown={(event) => start(event, corner)} aria-hidden="true" />)}
  </div>;
}
