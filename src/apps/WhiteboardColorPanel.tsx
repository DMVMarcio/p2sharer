import { useEffect, useState } from 'react';
import { ArrowLeftRight, Pipette, RotateCcw } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { hexToHsv, hsvToHex, type Hsv } from '../core/hsv_color';
import { t } from '../i18n';

const STUDIO_SWATCHES = [
  '#000000', '#334155', '#64748b', '#94a3b8', '#cbd5e1', '#ffffff',
  '#ef4444', '#f97316', '#f59e0b', '#facc15', '#84cc16', '#22c55e',
  '#10b981', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#a47754', '#78350f',
] as const;

export function WhiteboardColorPanel({
  color,
  secondaryColor,
  recentColors,
  isEyedropper,
  onColorChange,
  onSecondaryColorChange,
  onSwapColors,
  onResetColors,
  onPickEyedropper,
}: {
  color: string;
  secondaryColor: string;
  recentColors: readonly string[];
  isEyedropper: boolean;
  onColorChange(color: string): void;
  onSecondaryColorChange(color: string): void;
  onSwapColors(): void;
  onResetColors(): void;
  onPickEyedropper(): void;
}) {
  const [editingSecondary, setEditingSecondary] = useState(false);
  const activeHex = editingSecondary ? secondaryColor : color;
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(activeHex));
  const [hexDraft, setHexDraft] = useState(activeHex);

  useEffect(() => {
    setHsv(hexToHsv(activeHex));
    setHexDraft(activeHex);
  }, [activeHex]);

  const applyColor = (nextHex: string, nextHsv?: Hsv) => {
    const normalized = nextHex.toLowerCase();
    if (nextHsv) setHsv(nextHsv);
    setHexDraft(normalized);
    if (editingSecondary) onSecondaryColorChange(normalized);
    else onColorChange(normalized);
  };

  const updateSvFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    const s = Math.max(0, Math.min(1, (event.clientX - rect.left) / w));
    const v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / h));
    const nextHsv: Hsv = { h: hsv.h, s, v };
    applyColor(hsvToHex(nextHsv), nextHsv);
  };

  return (
    <section className="whiteboard-color-studio" aria-label={t('whiteboard.colorStudio')}>
      <div className="whiteboard-color-header">
        <div className="whiteboard-color-wells">
          <TooltipButton
            tooltip={t('whiteboard.primaryColor')}
            aria-label={t('whiteboard.primaryColor')}
            aria-pressed={!editingSecondary}
            className={`whiteboard-color-well is-primary ${!editingSecondary ? 'active' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => setEditingSecondary(false)}
          />
          <TooltipButton
            tooltip={t('whiteboard.secondaryColor')}
            aria-label={t('whiteboard.secondaryColor')}
            aria-pressed={editingSecondary}
            className={`whiteboard-color-well is-secondary ${editingSecondary ? 'active' : ''}`}
            style={{ backgroundColor: secondaryColor }}
            onClick={() => setEditingSecondary(true)}
          />
          <TooltipButton
            tooltip={`${t('whiteboard.swapColors')} (X)`}
            aria-label={t('whiteboard.swapColors')}
            aria-keyshortcuts="X"
            className="room-app-notepad-tool whiteboard-color-mini-btn"
            onClick={onSwapColors}
          >
            <ArrowLeftRight size={13} />
          </TooltipButton>
          <TooltipButton
            tooltip={`${t('whiteboard.resetColors')} (D)`}
            aria-label={t('whiteboard.resetColors')}
            aria-keyshortcuts="D"
            className="room-app-notepad-tool whiteboard-color-mini-btn"
            onClick={onResetColors}
          >
            <RotateCcw size={13} />
          </TooltipButton>
        </div>
        <div className="whiteboard-color-hex-group">
          <input
            autoComplete="off"
            spellCheck={false}
            maxLength={7}
            aria-label={t('whiteboard.hexColor')}
            className="text-input-sm whiteboard-color-hex-input"
            value={hexDraft}
            onChange={event => {
              const raw = event.target.value;
              setHexDraft(raw);
              const candidate = raw.startsWith('#') ? raw : `#${raw}`;
              if (/^#[0-9a-f]{6}$/i.test(candidate)) {
                applyColor(candidate, hexToHsv(candidate));
              }
            }}
            onBlur={() => setHexDraft(activeHex)}
          />
          <TooltipButton
            tooltip={`${t('whiteboard.eyedropper')} (I)`}
            aria-label={t('whiteboard.eyedropper')}
            aria-pressed={isEyedropper}
            className={`room-app-notepad-tool whiteboard-color-mini-btn ${isEyedropper ? 'active' : ''}`}
            onClick={onPickEyedropper}
          >
            <Pipette size={14} />
          </TooltipButton>
        </div>
      </div>

      <div
        className="whiteboard-color-sv"
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        role="group"
        aria-label={t('whiteboard.colorSquare')}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateSvFromPointer(event);
        }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            updateSvFromPointer(event);
          }
        }}
      >
        <span
          className="whiteboard-color-sv-cursor"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>

      <div className="whiteboard-color-hue-row">
        <input
          autoComplete="off"
          type="range"
          min={0}
          max={359}
          step={1}
          value={Math.round(hsv.h)}
          aria-label={t('whiteboard.colorHue')}
          className="settings-slider-input color-picker-hue whiteboard-hue-slider"
          onChange={event => {
            const nextHsv: Hsv = { ...hsv, h: Number(event.target.value) };
            applyColor(hsvToHex(nextHsv), nextHsv);
          }}
        />
      </div>

      <div className="whiteboard-swatches-grid" role="group" aria-label={t('whiteboard.swatches')}>
        {STUDIO_SWATCHES.map(swatch => (
          <button
            key={swatch}
            type="button"
            aria-label={swatch}
            aria-pressed={activeHex.toLowerCase() === swatch}
            className={`whiteboard-swatch-btn ${activeHex.toLowerCase() === swatch ? 'active' : ''}`}
            style={{ backgroundColor: swatch }}
            onClick={() => applyColor(swatch, hexToHsv(swatch))}
          />
        ))}
      </div>

      {recentColors.length > 0 && (
        <div className="whiteboard-recent-colors" role="group" aria-label={t('whiteboard.recentColors')}>
          {recentColors.slice(0, 8).map(recent => (
            <button
              key={recent}
              type="button"
              aria-label={recent}
              className={`whiteboard-swatch-btn is-recent ${activeHex.toLowerCase() === recent.toLowerCase() ? 'active' : ''}`}
              style={{ backgroundColor: recent }}
              onClick={() => applyColor(recent, hexToHsv(recent))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
