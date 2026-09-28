import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getEmojiIndex } from '../../core/emoji_catalog';
import type { EmojiPack } from '../../core/emoji_preferences';
import { getEmojiVisual } from '../../core/emoji_visual';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const decorationKey = new PluginKey('chatEmojiDecorations');

export const ChatEmojiDecorations = Extension.create<{ getPack: () => EmojiPack }>({
  name: 'chatEmojiDecorations',
  addOptions() {
    return { getPack: () => 'twemoji' };
  },
  addProseMirrorPlugins() {
    const getPack = this.options.getPack;
    return [new Plugin({
      key: decorationKey,
      props: {
        decorations(state) {
          const pack = getPack();
          const decorations: Decoration[] = [];
          state.doc.descendants((node, position) => {
            if (!node.isText || !node.text) return;
            for (const { segment, index } of segmenter.segment(node.text)) {
              if (getEmojiIndex(segment) === undefined) continue;
              const visual = getEmojiVisual(segment, pack, 16);
              if (visual.native) continue;
              const style = visual.style;
              decorations.push(Decoration.inline(position + index, position + index + segment.length, {
                class: `chat-editor-emoji emoji-pack-${pack}`,
                style: `width:16px;height:16px;background-size:${style.backgroundSize};background-position:${style.backgroundPosition}`,
              }));
            }
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
