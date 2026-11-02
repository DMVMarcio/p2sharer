import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Circle, Pipette, RotateCcw, Square, Triangle } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { hexToHsv, hsvToHex, type Hsv } from '../core/hsv_color';
import { t } from '../i18n';

export type ColorPickerMode = 'square' | 'triangle' | 'wheel';

function loadPickerMode(): ColorPickerMode {
  try {
    const raw = localStorage.getItem('p2sharer_whiteboard_picker_mode');
    if (raw === 'triangle' || raw === 'wheel' || raw === 'square') return raw;
  } catch { /* ignore */ }
  return 'square';
}

const WHEEL_SIZE = 156;
const WHEEL_CENTER = WHEEL_SIZE / 2;
const RING_OUTER_R = 72;
const RING_INNER_R = 57;
const RING_MID_R = (RING_OUTER_R + RING_INNER_R) / 2;
const TRI_R = 54;
const DISC_R = 70;

function polarPoint(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function triangleVertices(hueDeg: number): {
  a: { x: number; y: number };
  w: { x: number; y: number };
  b: { x: number; y: number };
} {
  return {
    a: polarPoint(WHEEL_CENTER, WHEEL_CENTER, TRI_R, hueDeg),
    w: polarPoint(WHEEL_CENTER, WHEEL_CENTER, TRI_R, hueDeg + 120),
    b: polarPoint(WHEEL_CENTER, WHEEL_CENTER, TRI_R, hueDeg - 120),
  };
}

function barycentricTriangle(
  px: number,
  py: number,
  a: { x: number; y: number },
  w: { x: number; y: number },
  b: { x: number; y: number },
): { uA: number; uW: number; uB: number } {
  const det = (w.y - b.y) * (a.x - b.x) + (b.x - w.x) * (a.y - b.y);
  if (Math.abs(det) < 1e-6) return { uA: 1, uW: 0, uB: 0 };
  const uA = ((w.y - b.y) * (px - b.x) + (b.x - w.x) * (py - b.y)) / det;
  const uW = ((b.y - a.y) * (px - b.x) + (a.x - b.x) * (py - b.y)) / det;
  const uB = 1 - uA - uW;
  return { uA, uW, uB };
}

export function WhiteboardColorPanel({
  color,
  secondaryColor,
  recentColors,
  isEyedropper,
  onColorChange,
  onSecondaryColorChange,
  onCommitColor,
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
  onCommitColor?(color: string): void;
  onSwapColors(): void;
  onResetColors(): void;
  onPickEyedropper(): void;
}) {
  const [editingSecondary, setEditingSecondary] = useState(false);
  const [pickerMode, setPickerMode] = useState<ColorPickerMode>(loadPickerMode);
  const activeHex = editingSecondary ? secondaryColor : color;
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(activeHex));
  const [hexDraft, setHexDraft] = useState(activeHex);
  const triangleDragZone = useRef<'ring' | 'triangle' | null>(null);

  useEffect(() => {
    setHsv(hexToHsv(activeHex));
    setHexDraft(activeHex);
  }, [activeHex]);

  const changePickerMode = (mode: ColorPickerMode) => {
    setPickerMode(mode);
    try { localStorage.setItem('p2sharer_whiteboard_picker_mode', mode); } catch { /* ignore */ }
  };

  const applyColor = (nextHex: string, nextHsv?: Hsv, commit = false) => {
    const normalized = nextHex.toLowerCase();
    if (nextHsv) setHsv(nextHsv);
    setHexDraft(normalized);
    if (editingSecondary) onSecondaryColorChange(normalized);
    else onColorChange(normalized);
    if (commit) onCommitColor?.(normalized);
  };

  const updateSvFromPointer = (event: React.PointerEvent<HTMLDivElement>, commit = false) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    const s = Math.max(0, Math.min(1, (event.clientX - rect.left) / w));
    const v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / h));
    const nextHsv: Hsv = { h: hsv.h, s, v };
    applyColor(hsvToHex(nextHsv), nextHsv, commit);
  };

  const updateTriangleWheelFromPointer = (
    event: React.PointerEvent<HTMLDivElement>,
    isDown: boolean,
    commit = false,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = WHEEL_SIZE / Math.max(1, rect.width);
    const scaleY = WHEEL_SIZE / Math.max(1, rect.height);
    const px = (event.clientX - rect.left) * scaleX;
    const py = (event.clientY - rect.top) * scaleY;
    const dx = px - WHEEL_CENTER;
    const dy = py - WHEEL_CENTER;
    const dist = Math.hypot(dx, dy);

    if (isDown) {
      triangleDragZone.current = dist >= RING_INNER_R - 2 ? 'ring' : 'triangle';
    }
    const zone = triangleDragZone.current ?? (dist >= RING_INNER_R - 2 ? 'ring' : 'triangle');

    if (zone === 'ring') {
      const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const nextHsv: Hsv = { h: deg, s: hsv.s, v: hsv.v };
      applyColor(hsvToHex(nextHsv), nextHsv, commit);
    } else {
      const { a, w, b } = triangleVertices(hsv.h);
      const raw = barycentricTriangle(px, py, a, w, b);
      let cA = Math.max(0, raw.uA);
      let cW = Math.max(0, raw.uW);
      let cB = Math.max(0, raw.uB);
      const sum = cA + cW + cB;
      if (sum > 1e-6) {
        cA /= sum;
        cW /= sum;
        cB /= sum;
      } else {
        cA = 1; cW = 0; cB = 0;
      }
      const v = Math.max(0, Math.min(1, 1 - cB));
      const s = v <= 1e-5 ? hsv.s : Math.max(0, Math.min(1, cA / v));
      const nextHsv: Hsv = { h: hsv.h, s, v };
      applyColor(hsvToHex(nextHsv), nextHsv, commit);
    }
  };

  const updateCircularWheelFromPointer = (event: React.PointerEvent<HTMLDivElement>, commit = false) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = WHEEL_SIZE / Math.max(1, rect.width);
    const scaleY = WHEEL_SIZE / Math.max(1, rect.height);
    const px = (event.clientX - rect.left) * scaleX;
    const py = (event.clientY - rect.top) * scaleY;
    const dx = px - WHEEL_CENTER;
    const dy = py - WHEEL_CENTER;
    const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const s = Math.max(0, Math.min(1, Math.hypot(dx, dy) / DISC_R));
    const nextHsv: Hsv = { h: deg, s, v: hsv.v };
    applyColor(hsvToHex(nextHsv), nextHsv, commit);
  };

  const triVerts = triangleVertices(hsv.h);
  const wA = hsv.v * hsv.s;
  const wW = hsv.v * (1 - hsv.s);
  const wB = 1 - hsv.v;
  const triCursorX = wA * triVerts.a.x + wW * triVerts.w.x + wB * triVerts.b.x;
  const triCursorY = wA * triVerts.a.y + wW * triVerts.w.y + wB * triVerts.b.y;
  const ringCursor = polarPoint(WHEEL_CENTER, WHEEL_CENTER, RING_MID_R, hsv.h);
  const discCursor = polarPoint(WHEEL_CENTER, WHEEL_CENTER, hsv.s * DISC_R, hsv.h);
  const pureHueHex = hsvToHex({ h: hsv.h, s: 1, v: 1 });

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
            onBlur={() => {
              const candidate = hexDraft.startsWith('#') ? hexDraft : `#${hexDraft}`;
              if (/^#[0-9a-f]{6}$/i.test(candidate)) {
                onCommitColor?.(candidate.toLowerCase());
              }
              setHexDraft(activeHex);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
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

      <div className="whiteboard-color-mode-bar" role="group">
        <TooltipButton
          tooltip={t('whiteboard.pickerSquare')}
          aria-label={t('whiteboard.pickerSquare')}
          aria-pressed={pickerMode === 'square'}
          className={`room-app-notepad-tool whiteboard-color-mode-btn ${pickerMode === 'square' ? 'active' : ''}`}
          onClick={() => changePickerMode('square')}
        >
          <Square size={12} />
        </TooltipButton>
        <TooltipButton
          tooltip={t('whiteboard.pickerTriangle')}
          aria-label={t('whiteboard.pickerTriangle')}
          aria-pressed={pickerMode === 'triangle'}
          className={`room-app-notepad-tool whiteboard-color-mode-btn ${pickerMode === 'triangle' ? 'active' : ''}`}
          onClick={() => changePickerMode('triangle')}
        >
          <Triangle size={12} />
        </TooltipButton>
        <TooltipButton
          tooltip={t('whiteboard.pickerWheel')}
          aria-label={t('whiteboard.pickerWheel')}
          aria-pressed={pickerMode === 'wheel'}
          className={`room-app-notepad-tool whiteboard-color-mode-btn ${pickerMode === 'wheel' ? 'active' : ''}`}
          onClick={() => changePickerMode('wheel')}
        >
          <Circle size={12} />
        </TooltipButton>
      </div>

      {pickerMode === 'square' && (
        <>
          <div
            className="whiteboard-color-sv"
            style={{ backgroundColor: pureHueHex }}
            role="group"
            aria-label={t('whiteboard.colorSquare')}
            onPointerDown={event => {
              event.currentTarget.setPointerCapture(event.pointerId);
              updateSvFromPointer(event, false);
            }}
            onPointerMove={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                updateSvFromPointer(event, false);
              }
            }}
            onPointerUp={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
                updateSvFromPointer(event, true);
              }
            }}
            onPointerCancel={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
                onCommitColor?.(activeHex);
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
                applyColor(hsvToHex(nextHsv), nextHsv, false);
              }}
              onPointerUp={() => onCommitColor?.(activeHex)}
              onKeyUp={() => onCommitColor?.(activeHex)}
            />
          </div>
        </>
      )}

      {pickerMode === 'triangle' && (
        <div
          className="whiteboard-color-wheel-stage is-triangle"
          role="group"
          aria-label={t('whiteboard.colorSquare')}
          onPointerDown={event => {
            event.currentTarget.setPointerCapture(event.pointerId);
            updateTriangleWheelFromPointer(event, true, false);
          }}
          onPointerMove={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              updateTriangleWheelFromPointer(event, false, false);
            }
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
              updateTriangleWheelFromPointer(event, false, true);
              triangleDragZone.current = null;
            }
          }}
          onPointerCancel={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
              triangleDragZone.current = null;
              onCommitColor?.(activeHex);
            }
          }}
        >
          <div className="whiteboard-color-hue-ring" />
          <svg
            className="whiteboard-color-triangle-svg"
            viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id="wb-tri-val-grad"
                gradientUnits="userSpaceOnUse"
                x1={triVerts.w.x}
                y1={triVerts.w.y}
                x2={(triVerts.a.x + triVerts.b.x) / 2}
                y2={(triVerts.a.y + triVerts.b.y) / 2}
              >
                <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
                <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
              </linearGradient>
              <linearGradient
                id="wb-tri-blk-grad"
                gradientUnits="userSpaceOnUse"
                x1={triVerts.b.x}
                y1={triVerts.b.y}
                x2={(triVerts.a.x + triVerts.w.x) / 2}
                y2={(triVerts.a.y + triVerts.w.y) / 2}
              >
                <stop offset="0%" stopColor="#000000" stopOpacity={1} />
                <stop offset="100%" stopColor="#000000" stopOpacity={0} />
              </linearGradient>
            </defs>
            <polygon
              points={`${triVerts.a.x},${triVerts.a.y} ${triVerts.w.x},${triVerts.w.y} ${triVerts.b.x},${triVerts.b.y}`}
              fill={pureHueHex}
            />
            <polygon
              points={`${triVerts.a.x},${triVerts.a.y} ${triVerts.w.x},${triVerts.w.y} ${triVerts.b.x},${triVerts.b.y}`}
              fill="url(#wb-tri-val-grad)"
            />
            <polygon
              points={`${triVerts.a.x},${triVerts.a.y} ${triVerts.w.x},${triVerts.w.y} ${triVerts.b.x},${triVerts.b.y}`}
              fill="url(#wb-tri-blk-grad)"
              stroke="rgba(255, 255, 255, 0.28)"
              strokeWidth={1}
            />
          </svg>
          <span
            className="whiteboard-color-sv-cursor is-ring-cursor"
            style={{
              left: `${(ringCursor.x / WHEEL_SIZE) * 100}%`,
              top: `${(ringCursor.y / WHEEL_SIZE) * 100}%`,
              backgroundColor: pureHueHex,
            }}
          />
          <span
            className="whiteboard-color-sv-cursor"
            style={{
              left: `${(triCursorX / WHEEL_SIZE) * 100}%`,
              top: `${(triCursorY / WHEEL_SIZE) * 100}%`,
              backgroundColor: activeHex,
            }}
          />
        </div>
      )}

      {pickerMode === 'wheel' && (
        <>
          <div
            className="whiteboard-color-wheel-stage is-disc"
            role="group"
            aria-label={t('whiteboard.colorSquare')}
            onPointerDown={event => {
              event.currentTarget.setPointerCapture(event.pointerId);
              updateCircularWheelFromPointer(event, false);
            }}
            onPointerMove={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                updateCircularWheelFromPointer(event, false);
              }
            }}
            onPointerUp={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
                updateCircularWheelFromPointer(event, true);
              }
            }}
            onPointerCancel={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
                onCommitColor?.(activeHex);
              }
            }}
          >
            <div className="whiteboard-color-hs-disc">
              <div
                className="whiteboard-color-hs-disc-shade"
                style={{ opacity: 1 - hsv.v }}
              />
            </div>
            <span
              className="whiteboard-color-sv-cursor"
              style={{
                left: `${(discCursor.x / WHEEL_SIZE) * 100}%`,
                top: `${(discCursor.y / WHEEL_SIZE) * 100}%`,
                backgroundColor: activeHex,
              }}
            />
          </div>

          <div className="whiteboard-color-hue-row">
            <input
              autoComplete="off"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(hsv.v * 100)}
              aria-label={t('whiteboard.colorBrightness')}
              className="settings-slider-input whiteboard-brightness-slider"
              style={{
                background: `linear-gradient(to right, #000000, ${hsvToHex({ h: hsv.h, s: hsv.s, v: 1 })})`,
              }}
              onChange={event => {
                const nextHsv: Hsv = { ...hsv, v: Number(event.target.value) / 100 };
                applyColor(hsvToHex(nextHsv), nextHsv, false);
              }}
              onPointerUp={() => onCommitColor?.(activeHex)}
              onKeyUp={() => onCommitColor?.(activeHex)}
            />
          </div>
        </>
      )}

      {recentColors.length > 0 && (
        <div className="whiteboard-recent-colors" role="group" aria-label={t('whiteboard.recentColors')}>
          {recentColors.slice(0, 8).map(recent => (
            <TooltipButton
              key={recent}
              tooltip={recent}
              aria-label={recent}
              className={`whiteboard-swatch-btn is-recent ${activeHex.toLowerCase() === recent.toLowerCase() ? 'active' : ''}`}
              style={{ backgroundColor: recent }}
              onClick={() => applyColor(recent, hexToHsv(recent), true)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
