import { useCallback, useSyncExternalStore } from 'react';
import { safeChatUrl } from '../core/chat_links.ts';
import { stateStore } from '../core/state_store.ts';

export type ModalType =
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

class ModalManager {
  private activeModal: ModalType = null;
  private isClosing: boolean = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private externalLinkUrl: string | null = null;
  private revision = 0;

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
    this.externalLinkUrl = safeUrl;
    this.open('externalLink');
  }

  public open(modal: ModalType): void {
    this.revision++;
    if (modal !== 'externalLink') this.externalLinkUrl = null;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.isClosing = false;
    this.activeModal = modal;
    this.notify();
  }

  public close(): void {
    if (!this.activeModal || this.isClosing) return;
    this.isClosing = true;
    this.notify();

    this.closeTimer = setTimeout(() => {
      if (this.activeModal === 'screenPicker') stateStore.set((state) => { state.editingStreamId = null; });
      this.activeModal = null;
      this.externalLinkUrl = null;
      this.isClosing = false;
      this.closeTimer = null;
      this.notify();
    }, 240);
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
    openModal,
    closeModal,
    isOpen,
  };
}
