import { overlayMotionDuration } from '../core/overlay_motion.ts';
import { useOverlayMotion } from './useOverlayMotion.ts';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { safeChatUrl } from '../core/chat_links.ts';
import { stateStore } from '../core/state_store.ts';

export type ModalType =
  | 'profile'
  | 'settings'
  | 'screenPicker'
  | 'username'
  | 'audioFilter'
  | 'createRoom'
  | 'joinRoom'
  | 'saveInvite'
  | 'roomSecurity'
  | 'externalLink'
  | 'apps'
  | null;

export interface ProfileTarget { peerId: string; name: string; isLocal?: boolean; color?: string }

class ModalManager {
  private activeModal: ModalType = null;
  private isClosing: boolean = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private externalLinkUrl: string | null = null;
  private pending: { modal: ModalType; url: string | null } | null = null;
  private revision = 0;
  private profileTarget: ProfileTarget | null = null;
  public getProfileTarget() { return this.profileTarget; }
  public openProfile(target: ProfileTarget) { this.profileTarget = { ...target }; this.open('profile'); }

  public getRevision(): number { return this.revision; }

  public getActive(): ModalType {
    return this.activeModal;
  }

  public getIsClosing(): boolean {
    return this.isClosing;
  }

  public getExternalLinkUrl(): string | null {
    return this.externalLinkUrl;
  }

  public openExternalLink(url: string): void {
    const safeUrl = safeChatUrl(url);
    if (!safeUrl) return;
    this.open('externalLink', safeUrl);
  }

  public open(modal: ModalType, externalUrl: string | null = null): void {
    const url = modal === 'externalLink' ? externalUrl ?? this.externalLinkUrl : null;
    if (this.activeModal && modal && modal !== this.activeModal && overlayMotionDuration('dialog', false) > 0) {
      this.pending = { modal, url };
      this.close();
      return;
    }
    this.revision++;
    if (modal !== 'profile') this.profileTarget = null;
    this.pending = null;
    this.externalLinkUrl = url;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.isClosing = false;
    this.activeModal = modal;
    this.notify();
  }

  public close(immediate = false): void {
    if (!this.activeModal || (this.isClosing && !immediate)) return;
    this.isClosing = true;
    this.notify();

    const finish = () => {
      if (this.activeModal === 'screenPicker') stateStore.set((state) => { state.editingStreamId = null; });
      if (this.pending) this.revision++;
      this.activeModal = this.pending?.modal ?? null;
      if (this.activeModal !== 'profile') this.profileTarget = null;
      this.externalLinkUrl = this.pending?.url ?? null;
      this.pending = null;
      this.isClosing = false;
      this.closeTimer = null;
      this.notify();
    };
    if (immediate) { if (this.closeTimer) clearTimeout(this.closeTimer); finish(); }
    else this.closeTimer = setTimeout(finish, overlayMotionDuration('dialog', false));
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

export const modalManager = new ModalManager();

export function useModal() {
  const modalRevision = useSyncExternalStore(
    cb => modalManager.subscribe(cb), () => modalManager.getRevision(), () => modalManager.getRevision());
  const activeModal = useSyncExternalStore(
    (cb) => modalManager.subscribe(cb),
    () => modalManager.getActive(),
    () => modalManager.getActive()
  );

  const isClosing = useSyncExternalStore(
    (cb) => modalManager.subscribe(cb),
    () => modalManager.getIsClosing(),
    () => modalManager.getIsClosing()
  );

  const overlayRef = useRef<HTMLDivElement>(null);
  useOverlayMotion(overlayRef, activeModal !== null && !isClosing, 'dialog');
  const dismissModal = useCallback(() => modalManager.close(true), []);

  const openModal = useCallback((modal: ModalType) => {
    modalManager.open(modal);
  }, []);

  const closeModal = useCallback(() => {
    modalManager.close();
  }, []);

  const isOpen = useCallback(
    (modal: ModalType) => activeModal === modal && !isClosing,
    [activeModal, isClosing]
  );

  return {
    modalRevision,
    activeModal,
    isClosing,
    overlayRef,
    dismissModal,
    openModal,
    closeModal,
    isOpen,
  };
}
