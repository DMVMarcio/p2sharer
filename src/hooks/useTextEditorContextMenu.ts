import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { registerTextEditor } from '../core/ui/text_editing';

export function useTextEditorContextMenu(editor: Editor | null) {
  useEffect(() => {
    if (editor && !editor.isDestroyed) return registerTextEditor(editor);
  }, [editor]);
}
