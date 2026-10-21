import { blobToDataUrl } from '../core/image_clipboard';
import { t } from '../i18n/index.ts';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { invoke } from '../platform/commands.ts';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { NativeChatFile } from '../p2p/group_room';
import { showToast } from './useToast';
import { pickBrowserFiles, registerBrowserFile } from '../platform/web_files';
import type { ChatOfferFile } from '../components/room/ChatFileOfferDialog';

export function useChatFileInput(paneRef: RefObject<HTMLDivElement | null>) {
  const [files, setFiles] = useState<ChatOfferFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const queue = useRef<ChatOfferFile[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const offered = useRef(false);

  const discard = (file: ChatOfferFile) => {
    if (file.id && file.hash) {
      void invoke('discard_chat_file', { id: file.id }).catch(console.warn);
    }
  };

  const prepare = async (command: string, args?: Record<string, unknown>) => {
    if (busy.current) return;
    busy.current = true;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      if (args?.gifSource instanceof Promise) args = { ...args, gifSource: await args.gifSource };
      const result = await invoke<NativeChatFile[] | NativeChatFile | null>(command, args);
      if (controller.signal.aborted) return;
      const incoming = Array.isArray(result) ? result : result ? [result] : [];
      if (!mounted.current) { incoming.forEach(discard); return; }
      queue.current = incoming;
      setFiles(incoming);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('[Files] Could not prepare attachment:', error);
      if (mounted.current) showToast(t("message.3ac7f82e95fe"), 3500, 'error');
      queue.current.forEach(discard);
      queue.current = [];
      setFiles([]);
    } finally { busy.current = false; }
  };

  const receive = async (incoming: File[]) => {
    if (busy.current || queue.current.length || !incoming.length) return;
    if (incoming.length > 32) {
      showToast(t("message.3ac7f82e95fe"), 3500, 'error');
      return;
    }
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const initial: ChatOfferFile[] = incoming.map(file => ({
      id: crypto.randomUUID(),
      path: '',
      name: file.name,
      size: file.size,
      hash: '',
      isImage: file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name),
      loading: true,
    }));
    queue.current = initial;
    setFiles(initial);

    busy.current = true;
    try {
      for (let i = 0; i < incoming.length; i++) {
        if (controller.signal.aborted || !mounted.current) break;
        const file = incoming[i];
        const registered = await registerBrowserFile(file, file.name, controller.signal);
        if (controller.signal.aborted || !mounted.current) {
          discard(registered);
          break;
        }
        const match = queue.current.find(item => item.name === file.name && item.size === file.size && item.loading);
        if (match) {
          match.id = registered.id;
          match.path = registered.path;
          match.hash = registered.hash;
          match.isImage = registered.isImage;
          match.loading = false;
          setFiles([...queue.current]);
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return;
      console.warn('[Files] Could not prepare attachment:', error);
      if (mounted.current) showToast(t("message.3ac7f82e95fe"), 3500, 'error');
      queue.current.forEach(discard);
      queue.current = [];
      setFiles([]);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) {
      const pane = paneRef.current;
      const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragging(true); } };
      const leave = () => setDragging(false);
      const drop = (event: DragEvent) => {
        event.preventDefault(); setDragging(false);
        if (event.dataTransfer) void receive(Array.from(event.dataTransfer.files));
      };
      const paste = (event: ClipboardEvent) => {
        if (!event.clipboardData?.files.length) return;
        event.preventDefault(); void receive(Array.from(event.clipboardData.files));
      };
      pane?.addEventListener('dragover', over); pane?.addEventListener('dragleave', leave);
      pane?.addEventListener('drop', drop); pane?.addEventListener('paste', paste);
      return () => {
        mounted.current = false;
        abortControllerRef.current?.abort();
        queue.current.forEach(discard);
        queue.current = [];
        pane?.removeEventListener('dragover', over); pane?.removeEventListener('dragleave', leave);
        pane?.removeEventListener('drop', drop); pane?.removeEventListener('paste', paste);
      };
    }
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
      if (payload.type === 'drop' && inside) {
        const placeholders: ChatOfferFile[] = payload.paths.map(p => {
          const name = p.split(/[\\/]/).pop() || p;
          return { id: crypto.randomUUID(), path: p, name, size: 0, hash: '', isImage: /\.(png|jpe?g|gif|webp|bmp)$/i.test(name), loading: true };
        });
        queue.current = placeholders;
        setFiles(placeholders);
        void prepare('import_chat_files', { paths: payload.paths });
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch((error) => console.warn('[Files] Could not listen for file drops:', error));

    const onPaste = (event: ClipboardEvent) => {
      if (!inChat(event.target) || !event.clipboardData) return;
      const data = event.clipboardData;
      const html = data.getData('text/html');
      const source = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') : null;
      const gifSource = source && (/^data:image\/gif;base64,/i.test(source) || /^https?:\/\//i.test(source) && /\.gif(?:[?#]|$)/i.test(source)) ? source : null;
      const gif = Array.from(data.files).find(file => file.type === 'image/gif');
      if (!data.files.length && !gifSource) return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(pasteTimer);
      void prepare('paste_chat_files', gif || gifSource ? { gifSource: gif ? blobToDataUrl(gif) : gifSource } : undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'v' || !inChat(event.target)) return;
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => { if (available()) void prepare('paste_chat_files'); }, 50);
    };
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      disposed = true;
      mounted.current = false;
      unlisten?.();
      abortControllerRef.current?.abort();
      clearTimeout(pasteTimer);
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('keydown', onKeyDown, true);
      queue.current.forEach(discard);
      queue.current = [];
    };
  }, [paneRef]);

  const close = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const current = queue.current[0];
    if (current && !offered.current) discard(current);
    offered.current = false;
    queue.current = queue.current.slice(1);
    setFiles([...queue.current]);
  };

  return {
    selectedFile: files[0],
    dragging,
    close,
    markOffered: () => { offered.current = true; },
    pickFile: () => {
      if (!isTauri()) {
        void pickBrowserFiles().then(files => {
          if (files.length) void receive(files);
        });
      } else {
        void prepare('pick_chat_file');
      }
    },
  };
}
