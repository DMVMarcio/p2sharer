import { t } from '../i18n/index.ts';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { NativeChatFile } from '../p2p/group_room';
import { showToast } from './useToast';

export function useChatFileInput(paneRef: RefObject<HTMLDivElement | null>) {
  const [files, setFiles] = useState<NativeChatFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const queue = useRef<NativeChatFile[]>([]);
  const busy = useRef(false);
  const mounted = useRef(false);
  const offered = useRef(false);

  const discard = (file: NativeChatFile) => {
    void invoke('discard_chat_file', { id: file.id }).catch(console.warn);
  };
  const prepare = async (command: string, args?: Record<string, unknown>) => {
    if (busy.current || queue.current.length) return;
    busy.current = true;
    try {
      const result = await invoke<NativeChatFile[] | NativeChatFile | null>(command, args);
      const incoming = Array.isArray(result) ? result : result ? [result] : [];
      if (!mounted.current) { incoming.forEach(discard); return; }
      queue.current = incoming;
      setFiles(incoming);
    } catch (error) {
      console.warn('[Files] Could not prepare attachment:', error);
      if (mounted.current) showToast(t("message.3ac7f82e95fe"));
    } finally { busy.current = false; }
  };

  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) return () => { mounted.current = false; };
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let pasteTimer: ReturnType<typeof setTimeout> | undefined;
    const available = () => {
      const pane = paneRef.current;
      return Boolean(pane && pane.getClientRects().length && !document.querySelector('.modal-overlay') &&
        !busy.current && !queue.current.length);
    };
    const inChat = (target: EventTarget | null) => available() &&
      (target === document.body || target instanceof Node && paneRef.current?.contains(target));

    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === 'leave') { setDragging(false); return; }
      const rect = paneRef.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = Boolean(available() && rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      setDragging(payload.type !== 'drop' && inside);
      if (payload.type === 'drop' && inside) void prepare('import_chat_files', { paths: payload.paths });
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch((error) => console.warn('[Files] Could not listen for file drops:', error));

    const onPaste = (event: ClipboardEvent) => {
      if (!inChat(event.target) || !event.clipboardData?.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(pasteTimer);
      void prepare('paste_chat_files');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'v' || !inChat(event.target)) return;
      // Explorer file lists may not generate a DOM paste event in WebView2.
      // Let ordinary text paste run; image/file paste above cancels this fallback.
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => { if (available()) void prepare('paste_chat_files'); }, 0);
    };
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      disposed = true;
      mounted.current = false;
      unlisten?.();
      clearTimeout(pasteTimer);
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('keydown', onKeyDown, true);
      queue.current.forEach(discard);
      queue.current = [];
    };
  }, [paneRef]);

  const close = () => {
    const current = queue.current[0];
    if (current && !offered.current) discard(current);
    offered.current = false;
    queue.current = queue.current.slice(1);
    setFiles(queue.current);
  };
  return {
    selectedFile: files[0], dragging, close,
    markOffered: () => { offered.current = true; },
    pickFile: () => prepare('pick_chat_file'),
  };
}
