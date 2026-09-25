import { useCallback, useSyncExternalStore } from 'react';

export type ModalType =
  | 'settings'
  | 'screenPicker'
  | 'username'
  | 'audioFilter'
  | 'createRoom'
  | 'joinRoom'
  | 'roomSecurity'
  | null;

class ModalManager {
  private activeModal: ModalType = null;
  private listeners = new Set<() => void>();

  public getActive(): ModalType {
    return this.activeModal;
  }

  public open(modal: ModalType): void {
    this.activeModal = modal;
    this.notify();
  }

  public close(): void {
    this.activeModal = null;
    this.notify();
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
  const activeModal = useSyncExternalStore(
    (cb) => modalManager.subscribe(cb),
    () => modalManager.getActive(),
    () => modalManager.getActive()
  );

  const openModal = useCallback((modal: ModalType) => {
    modalManager.open(modal);
  }, []);

  const closeModal = useCallback(() => {
    modalManager.close();
  }, []);

  return {
    activeModal,
    openModal,
    closeModal,
    isOpen: (modal: ModalType) => activeModal === modal,
  };
}
