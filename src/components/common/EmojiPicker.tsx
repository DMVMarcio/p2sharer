import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Smile, Hand, PawPrint, UtensilsCrossed, MapPin, Gamepad2, Box, Hash, Flag } from 'lucide-react';
import { EMOJI_CATALOG, EMOJI_CATEGORIES, EMOJI_SEARCH_ALIASES, EmojiCategory } from '../../core/emoji_catalog';
import { EmojiPack } from '../../core/emoji_preferences';
import { EmojiGlyph } from './EmojiGlyph';

const CATEGORY_ICONS = [Smile, Hand, PawPrint, UtensilsCrossed, MapPin, Gamepad2, Box, Hash, Flag];
const PAGE_SIZE = 112;
type Props = { pack: EmojiPack; onSelect: (emoji: string) => void };

const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export const EmojiPicker: React.FC<Props> = ({ pack, onSelect }) => {
  const [activeCategory, setActiveCategory] = useState<EmojiCategory>(EMOJI_CATEGORIES[0].id);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const listRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<EmojiCategory, HTMLElement>());
  const normalizedQuery = normalize(query.trim());
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const scrollWithWheel = (event: WheelEvent) => {
      if (nav.scrollWidth <= nav.clientWidth) return;
      event.preventDefault();
      nav.scrollLeft += event.deltaY || event.deltaX;
    };
    nav.addEventListener('wheel', scrollWithWheel, { passive: false });
    return () => nav.removeEventListener('wheel', scrollWithWheel);
  }, []);
  const matching = useMemo(() => EMOJI_CATALOG.filter((entry) =>
    !normalizedQuery || normalize(`${entry.name} ${EMOJI_SEARCH_ALIASES[entry.emoji] ?? ''}`).includes(normalizedQuery) || entry.emoji.includes(normalizedQuery)
  ), [normalizedQuery]);
  const sections = useMemo(() => EMOJI_CATEGORIES.map((category) => ({
    ...category,
    entries: matching.filter((entry) => entry.category === category.id),
  })).filter((section) => section.entries.length), [matching]);

  const onListScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 110) {
      setVisibleCount((count) => Math.min(count + PAGE_SIZE, matching.length));
    }
    if (!normalizedQuery) {
      let current: EmojiCategory = EMOJI_CATEGORIES[0].id;
      for (const section of sections) {
        const element = sectionRefs.current.get(section.id);
        if (element && element.getBoundingClientRect().top <= list.getBoundingClientRect().top + 24) current = section.id;
      }
      setActiveCategory(current);
    }
  };

  const jumpToCategory = (category: EmojiCategory) => {
    setQuery('');
    const index = EMOJI_CATALOG.findIndex((entry) => entry.category === category);
    setVisibleCount(Math.max(PAGE_SIZE, index + PAGE_SIZE));
    setActiveCategory(category);
    requestAnimationFrame(() => {
      const section = sectionRefs.current.get(category);
      const list = listRef.current;
      if (section && list) list.scrollTop += section.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
  };

  let remaining = visibleCount;
  return (
    <div className="emoji-picker" role="dialog" aria-label="Selecionar emoji">
      <div className="emoji-picker-header"><strong>Emojis</strong></div>
      <input
        className="emoji-picker-search"
        type="search"
        placeholder="Buscar emoji..."
        aria-label="Buscar emoji"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setVisibleCount(PAGE_SIZE);
          if (listRef.current) listRef.current.scrollTop = 0;
        }}
      />
      <div ref={navRef} className="emoji-picker-categories" aria-label="Categorias de emojis">
        {EMOJI_CATEGORIES.map((item, index) => {
          const Icon = CATEGORY_ICONS[index];
          return (
            <button
              key={item.id}
              type="button"
              className={activeCategory === item.id && !normalizedQuery ? 'active' : ''}
              aria-label={item.label}
              aria-pressed={activeCategory === item.id && !normalizedQuery}
              onClick={() => jumpToCategory(item.id)}
            ><Icon size={17} strokeWidth={1.8} aria-hidden="true" /></button>
          );
        })}
      </div>
      <div className="emoji-picker-results" ref={listRef} onScroll={onListScroll}>
        {sections.map((section) => {
          const entries = section.entries.slice(0, remaining);
          remaining = Math.max(0, remaining - section.entries.length);
          if (!entries.length) return null;
          return (
            <section
              key={section.id}
              className="emoji-picker-section"
              ref={(node) => { if (node) sectionRefs.current.set(section.id, node); else sectionRefs.current.delete(section.id); }}
            >
              <h3 className="emoji-picker-section-label">{section.label}</h3>
              <div className="emoji-picker-grid">
                {entries.map((entry) => (
                  <button key={entry.emoji} type="button" aria-label={entry.name} onClick={() => onSelect(entry.emoji)}>
                    <EmojiGlyph emoji={entry.emoji} pack={pack} size={25} />
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!matching.length && <p className="emoji-picker-empty">Nenhum emoji encontrado.</p>}
      </div>
    </div>
  );
};
