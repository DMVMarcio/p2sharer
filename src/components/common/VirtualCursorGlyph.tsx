/**
 * Pointer silhouette adapted from Lucide.
 * ISC License
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { MousePointer2, TextCursor } from 'lucide-react';

export function VirtualCursorGlyph({ shape = 'default' }: { shape?: 'default' | 'text' | 'pointer' | 'grab' }) {
  return shape === 'grab' ? <svg width={22} height={24} viewBox="0 0 24 26" fill="currentColor" stroke="white" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12V10a2 2 0 0 1 4 0V8a2 2 0 0 1 4 0a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v6c0 5-2.5 8-7.5 8H11c-3 0-4.8-1.5-6.2-4l-2.3-4a2 2 0 0 1 2.5-3Z" />
    <path d="M9 10v3m4-5v5m4-4v4M5 12l4 2c2 1 2 3 1 4" fill="none" />
  </svg> : shape === 'text' ? <TextCursor size={15} className="virtual-cursor-text" aria-hidden="true" />
    : shape === 'pointer' ? <svg width={17} height={20} viewBox="0 0 24 24" preserveAspectRatio="none" fill="var(--accent-color)" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 14V4a2 2 0 0 1 4 0v5a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v1a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15Z" />
      <path d="M10 9v3m4-2v3m4-2v3" fill="none" />
    </svg>
      : <MousePointer2 size={20} fill="var(--accent-color)" aria-hidden="true" />;
}
