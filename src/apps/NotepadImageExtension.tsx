import React, { useEffect, useRef, useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { validProfileHash } from '../core/profile_image.ts';
import type { NotepadModel } from './models.ts';
import {
  decodeBase64, inspectPngBytes, prepareWhiteboardImage, sha256Hex, stripDataPrefix, validHttpImageUrl,
  verifyWhiteboardPng, WHITEBOARD_IMAGE_MAX_SIDE,
} from './whiteboard_image.ts';
import type { BoardResizeHandle } from './whiteboard_interaction.ts';

const HANDLES: BoardResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_IMAGE_SIZE = 24;
const DEFAULT_MAX_WIDTH = 560;

function clampDimension(value: unknown): number | null {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.max(MIN_IMAGE_SIZE, Math.min(WHITEBOARD_IMAGE_MAX_SIDE, Math.round(num)));
}

export function initialNoteImageDimensions(width: number, height: number): { width: number; height: number } {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const targetW = Math.min(DEFAULT_MAX_WIDTH, safeW);
  const targetH = Math.round(safeH * (targetW / safeW));
  return {
    width: Math.max(MIN_IMAGE_SIZE, Math.min(WHITEBOARD_IMAGE_MAX_SIDE, targetW)),
    height: Math.max(MIN_IMAGE_SIZE, Math.min(WHITEBOARD_IMAGE_MAX_SIDE, targetH)),
  };
}

export function resizedNoteImageDimensions(
  startW: number,
  startH: number,
  handle: BoardResizeHandle,
  dx: number,
  dy: number,
  keepAspect: boolean,
): { width: number; height: number } {
  let w = startW + (handle.includes('e') ? dx : handle.includes('w') ? -dx : 0);
  let h = startH + (handle.includes('s') ? dy : handle.includes('n') ? -dy : 0);
  w = Math.max(MIN_IMAGE_SIZE, Math.min(WHITEBOARD_IMAGE_MAX_SIDE, w));
  h = Math.max(MIN_IMAGE_SIZE, Math.min(WHITEBOARD_IMAGE_MAX_SIDE, h));
  if (keepAspect) {
    const bw = Math.max(1, startW), bh = Math.max(1, startH);
    const minScale = Math.max(MIN_IMAGE_SIZE / bw, MIN_IMAGE_SIZE / bh);
    const maxScale = Math.min(WHITEBOARD_IMAGE_MAX_SIDE / bw, WHITEBOARD_IMAGE_MAX_SIDE / bh);
    const rawScale = handle === 'n' || handle === 's'
      ? h / bh
      : handle === 'e' || handle === 'w'
        ? w / bw
        : Math.max(w / bw, h / bh);
    const scale = Math.max(minScale, Math.min(maxScale, rawScale));
    w = bw * scale;
    h = bh * scale;
  }
  return { width: Math.round(w), height: Math.round(h) };
}

function resolveNoteImageSrc(rawSrc: unknown, model?: NotepadModel): string {
  if (typeof rawSrc !== 'string' || !rawSrc) return '';
  if (rawSrc.startsWith('p2image:')) {
    const hash = rawSrc.slice(8);
    return validProfileHash(hash) ? model?.imageUrl(hash) ?? '' : '';
  }
  if (rawSrc.startsWith('data:image/png;base64,')) {
    try {
      const clean = stripDataPrefix(rawSrc);
      inspectPngBytes(decodeBase64(clean));
      return `data:image/png;base64,${clean}`;
    } catch {
      return '';
    }
  }
  return '';
}

const NotepadImageView: React.FC<NodeViewProps> = ({ node, selected, editor, updateAttributes }) => {
  const model = (editor.extensionManager.extensions.find(ext => ext.name === 'image')?.options as { model?: NotepadModel } | undefined)?.model;
  const imgRef = useRef<HTMLImageElement>(null);
  const [, setTick] = useState(0);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => model?.subscribe(() => setTick(v => v + 1)), [model]);

  useEffect(() => {
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
    if (!model) return;
    if (src.startsWith('data:image/png;base64,')) {
      let active = true;
      void (async () => {
        try {
          const clean = stripDataPrefix(src);
          const bytes = decodeBase64(clean);
          const dims = inspectPngBytes(bytes);
          const hash = await sha256Hex(bytes);
          if (!active) return;
          model.registerImage({ hash, data: clean, width: dims.width, height: dims.height });
          updateAttributes({ src: `p2image:${hash}` });
        } catch { /* ignore invalid inline data */ }
      })();
      return () => { active = false; };
    }
    if (validHttpImageUrl(src) && editor.isEditable) {
      let active = true;
      void (async () => {
        try {
          const image = await prepareWhiteboardImage(undefined, undefined, src.trim());
          if (!active) return;
          model.registerImage(image);
          const dims = initialNoteImageDimensions(image.width, image.height);
          updateAttributes({
            src: `p2image:${image.hash}`,
            width: clampDimension(node.attrs.width) ?? dims.width,
            height: clampDimension(node.attrs.height) ?? dims.height,
          });
        } catch { /* ignore remote fetch failure */ }
      })();
      return () => { active = false; };
    }
  }, [editor.isEditable, model, node.attrs.height, node.attrs.src, node.attrs.width, updateAttributes]);

  const resolvedSrc = resolveNoteImageSrc(node.attrs.src, model);
  const attrWidth = clampDimension(node.attrs.width);
  const attrHeight = clampDimension(node.attrs.height);
  const width = previewSize?.width ?? attrWidth;
  const height = previewSize?.height ?? attrHeight;
  const editable = editor.isEditable;

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, handle: BoardResizeHandle) => {
    if (!editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = imgRef.current?.getBoundingClientRect();
    const startW = Math.max(MIN_IMAGE_SIZE, width ?? Math.round(rect?.width || 240));
    const startH = Math.max(MIN_IMAGE_SIZE, height ?? Math.round(rect?.height || 180));
    const startX = event.clientX;
    const startY = event.clientY;
    let latest = { width: startW, height: startH };
    setPreviewSize(latest);

    const onMove = (moveEvent: PointerEvent) => {
      latest = resizedNoteImageDimensions(
        startW,
        startH,
        handle,
        moveEvent.clientX - startX,
        moveEvent.clientY - startY,
        moveEvent.shiftKey,
      );
      setPreviewSize(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setPreviewSize(null);
      updateAttributes({ width: latest.width, height: latest.height });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`notepad-image-wrapper ${selected && editable ? 'is-selected' : ''}`}
      data-drag-handle
    >
      {resolvedSrc ? (
        <img
          ref={imgRef}
          className="notepad-image-element"
          src={resolvedSrc}
          alt={typeof node.attrs.alt === 'string' ? node.attrs.alt : ''}
          width={width ?? undefined}
          height={height ?? undefined}
          style={width && height ? { width: `${width}px`, height: `${height}px` } : undefined}
          referrerPolicy="no-referrer"
          draggable={editable}
        />
      ) : (
        <span className="notepad-image-loading" aria-busy="true" />
      )}
      {selected && editable && resolvedSrc && (
        <span className="notepad-image-selection" contentEditable={false}>
          {HANDLES.map(handle => (
            <span
              key={handle}
              className={`notepad-image-handle handle-${handle}`}
              data-resize-handle={handle}
              onPointerDown={event => startResize(event, handle)}
            />
          ))}
        </span>
      )}
    </NodeViewWrapper>
  );
};

export function createNotepadImageExtension(model?: NotepadModel) {
  return Node.create<{ model?: NotepadModel }>({
    name: 'image',
    inline: true,
    group: 'inline',
    draggable: true,
    selectable: true,
    atom: true,

    addOptions() {
      return { model };
    },

    addAttributes() {
      return {
        src: { default: null },
        alt: { default: null },
        width: { default: null },
        height: { default: null },
      };
    },

    parseHTML() {
      return [
        {
          tag: 'img[src]',
          getAttrs: element => {
            if (!(element instanceof HTMLElement)) return false;
            const rawSrc = (element.getAttribute('src') ?? '').trim();
            const hashAttr = (element.getAttribute('data-image-hash') ?? '').trim().toLowerCase();
            const alt = element.getAttribute('alt') || null;
            let width = clampDimension(element.getAttribute('width'));
            let height = clampDimension(element.getAttribute('height'));
            let src = '';
            if (rawSrc.startsWith('p2image:') && validProfileHash(rawSrc.slice(8))) {
              src = rawSrc.toLowerCase();
            } else if (rawSrc.startsWith('data:image/png;base64,')) {
              try {
                const clean = stripDataPrefix(rawSrc);
                const dims = inspectPngBytes(decodeBase64(clean));
                if (width === null && height === null) {
                  width = Math.min(DEFAULT_MAX_WIDTH, dims.width);
                  height = Math.max(MIN_IMAGE_SIZE, Math.round(dims.height * (width / dims.width)));
                }
                if (validProfileHash(hashAttr)) {
                  this.options.model?.cacheImage(hashAttr, clean);
                  void verifyWhiteboardPng(clean, hashAttr).catch(() => {});
                  src = `p2image:${hashAttr}`;
                } else {
                  src = `data:image/png;base64,${clean}`;
                }
              } catch {
                return false;
              }
            } else if (validHttpImageUrl(rawSrc)) {
              src = rawSrc;
            } else {
              return false;
            }
            return { src, alt, width, height };
          },
        },
      ];
    },

    renderHTML({ HTMLAttributes }) {
      const rawSrc = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : '';
      let resolvedSrc = '';
      let imageHash: string | undefined;
      if (rawSrc.startsWith('p2image:')) {
        const hash = rawSrc.slice(8);
        if (validProfileHash(hash)) {
          imageHash = hash;
          resolvedSrc = this.options.model?.imageUrl(hash) ?? rawSrc;
        }
      } else if (rawSrc.startsWith('data:image/png;base64,')) {
        resolvedSrc = rawSrc;
      } else if (validHttpImageUrl(rawSrc)) {
        resolvedSrc = rawSrc;
      }
      const width = clampDimension(HTMLAttributes.width);
      const height = clampDimension(HTMLAttributes.height);
      const attrs: Record<string, string | number> = {
        src: resolvedSrc,
        referrerpolicy: 'no-referrer',
      };
      if (imageHash) attrs['data-image-hash'] = imageHash;
      if (typeof HTMLAttributes.alt === 'string' && HTMLAttributes.alt) attrs.alt = HTMLAttributes.alt;
      if (width !== null) attrs.width = width;
      if (height !== null) attrs.height = height;
      return ['img', mergeAttributes(attrs)];
    },

    markdownTokenName: 'image',

    parseMarkdown(token, helpers) {
      const href = typeof token.href === 'string' ? token.href.trim() : '';
      const alt = typeof token.text === 'string' && token.text ? token.text : null;
      if (href.startsWith('p2image:') && validProfileHash(href.slice(8))) {
        return helpers.createNode('image', { src: href.toLowerCase(), alt });
      }
      if (href.startsWith('data:image/png;base64,')) {
        try {
          const clean = stripDataPrefix(href);
          const dims = inspectPngBytes(decodeBase64(clean));
          const width = Math.min(DEFAULT_MAX_WIDTH, dims.width);
          const height = Math.max(MIN_IMAGE_SIZE, Math.round(dims.height * (width / dims.width)));
          return helpers.createNode('image', { src: `data:image/png;base64,${clean}`, alt, width, height });
        } catch {
          return [];
        }
      }
      if (validHttpImageUrl(href)) {
        return helpers.createNode('image', { src: href, alt });
      }
      return [];
    },

    renderMarkdown(node) {
      const rawSrc = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      const resolved = rawSrc.startsWith('p2image:')
        ? (model?.imageUrl(rawSrc.slice(8)) ?? rawSrc)
        : rawSrc;
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.replace(/[\[\]\r\n]/g, '') : '';
      return resolved ? `![${alt}](${resolved})` : '';
    },

    addNodeView() {
      return ReactNodeViewRenderer(NotepadImageView, {
        as: 'span',
        className: 'notepad-image-node',
      });
    },
  });
}
