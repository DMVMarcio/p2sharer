import React from 'react';
import type { GamepadTargetControl } from '../../../core/ui/input_bindings';
import type { GamepadSnapshotState } from '../../../core/stream/remote_control';
import { t } from '../../../i18n';

export const GAMEPAD_CONTROL_COLORS = {
  a: '#22c55e',
  b: '#ef4444',
  x: '#3b82f6',
  y: '#eab308',
  bumper: '#38bdf8',
  trigger: '#f97316',
  dpad: '#a855f7',
  leftStick: '#14b8a6',
  rightStick: '#ec4899',
  system: '#94a3b8',
  guide: '#22c55e',
} as const;

interface GamepadTargetGlyphProps {
  target: GamepadTargetControl;
  label: string;
}

export const GamepadTargetGlyph: React.FC<GamepadTargetGlyphProps> = ({ target, label }) => {
  switch (target) {
    case 'a':
    case 'b':
    case 'x':
    case 'y': {
      const color = GAMEPAD_CONTROL_COLORS[target];
      return (
        <span
          className="gp-glyph gp-glyph-face"
          style={{ borderColor: color, backgroundColor: `${color}26`, color }}
          aria-label={label}
        >
          {target.toUpperCase()}
        </span>
      );
    }
    case 'lb':
    case 'rb':
      return (
        <span
          className="gp-glyph gp-glyph-shoulder"
          style={{
            borderColor: GAMEPAD_CONTROL_COLORS.bumper,
            backgroundColor: `${GAMEPAD_CONTROL_COLORS.bumper}22`,
            color: GAMEPAD_CONTROL_COLORS.bumper,
          }}
          aria-label={label}
        >
          {target.toUpperCase()}
        </span>
      );
    case 'leftTrigger':
    case 'rightTrigger':
      return (
        <span
          className="gp-glyph gp-glyph-trigger"
          style={{
            borderColor: GAMEPAD_CONTROL_COLORS.trigger,
            backgroundColor: `${GAMEPAD_CONTROL_COLORS.trigger}22`,
            color: GAMEPAD_CONTROL_COLORS.trigger,
          }}
          aria-label={label}
        >
          {target === 'leftTrigger' ? 'LT' : 'RT'}
        </span>
      );
    case 'dpadUp':
    case 'dpadDown':
    case 'dpadLeft':
    case 'dpadRight': {
      const c = GAMEPAD_CONTROL_COLORS.dpad;
      const dim = 'currentColor';
      return (
        <span className="gp-glyph gp-glyph-svg" style={{ color: c }} aria-label={label}>
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <rect
              x="9.5"
              y="2.5"
              width="5"
              height="6.5"
              rx="1.2"
              fill={target === 'dpadUp' ? c : dim}
              fillOpacity={target === 'dpadUp' ? 1 : 0.22}
            />
            <rect
              x="9.5"
              y="15"
              width="5"
              height="6.5"
              rx="1.2"
              fill={target === 'dpadDown' ? c : dim}
              fillOpacity={target === 'dpadDown' ? 1 : 0.22}
            />
            <rect
              x="2.5"
              y="9.5"
              width="6.5"
              height="5"
              rx="1.2"
              fill={target === 'dpadLeft' ? c : dim}
              fillOpacity={target === 'dpadLeft' ? 1 : 0.22}
            />
            <rect
              x="15"
              y="9.5"
              width="6.5"
              height="5"
              rx="1.2"
              fill={target === 'dpadRight' ? c : dim}
              fillOpacity={target === 'dpadRight' ? 1 : 0.22}
            />
            <rect x="9.5" y="9.5" width="5" height="5" fill={dim} fillOpacity="0.22" />
          </svg>
        </span>
      );
    }
    case 'ls':
    case 'rs': {
      const isLeft = target === 'ls';
      const color = isLeft ? GAMEPAD_CONTROL_COLORS.leftStick : GAMEPAD_CONTROL_COLORS.rightStick;
      return (
        <span
          className="gp-glyph gp-glyph-stick-click"
          style={{ borderColor: color, backgroundColor: `${color}22`, color }}
          aria-label={label}
        >
          {isLeft ? 'L3' : 'R3'}
        </span>
      );
    }
    case 'lxNeg':
    case 'lxPos':
    case 'lyPos':
    case 'lyNeg':
    case 'rxNeg':
    case 'rxPos':
    case 'ryPos':
    case 'ryNeg': {
      const isLeft = target.startsWith('l');
      const color = isLeft ? GAMEPAD_CONTROL_COLORS.leftStick : GAMEPAD_CONTROL_COLORS.rightStick;
      const arrowPath =
        target === 'lyPos' || target === 'ryPos'
          ? 'M12 2.5L15 6.5H9L12 2.5Z'
          : target === 'lyNeg' || target === 'ryNeg'
            ? 'M12 21.5L15 17.5H9L12 21.5Z'
            : target === 'lxNeg' || target === 'rxNeg'
              ? 'M2.5 12L6.5 9V15L2.5 12Z'
              : 'M21.5 12L17.5 9V15L21.5 12Z';
      return (
        <span className="gp-glyph gp-glyph-svg" style={{ color }} aria-label={label}>
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="5.5" fill={color} fillOpacity="0.22" stroke={color} strokeWidth="1.5" />
            <text x="12" y="14.3" textAnchor="middle" fontSize="6.8" fontWeight="800" fill={color}>
              {isLeft ? 'L' : 'R'}
            </text>
            <path d={arrowPath} fill={color} />
          </svg>
        </span>
      );
    }
    case 'back':
      return (
        <span
          className="gp-glyph gp-glyph-svg"
          style={{ color: GAMEPAD_CONTROL_COLORS.system }}
          aria-label={label}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="4" y="8" width="9" height="9" rx="1.5" />
            <path d="M10 6h8a1.5 1.5 0 0 1 1.5 1.5v8" />
          </svg>
        </span>
      );
    case 'start':
      return (
        <span
          className="gp-glyph gp-glyph-svg"
          style={{ color: GAMEPAD_CONTROL_COLORS.system }}
          aria-label={label}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <line x1="5" y1="7" x2="19" y2="7" />
            <line x1="5" y1="12" x2="19" y2="12" />
            <line x1="5" y1="17" x2="19" y2="17" />
          </svg>
        </span>
      );
    case 'guide':
      return (
        <span
          className="gp-glyph gp-glyph-guide"
          style={{
            borderColor: GAMEPAD_CONTROL_COLORS.guide,
            backgroundColor: `${GAMEPAD_CONTROL_COLORS.guide}20`,
            color: GAMEPAD_CONTROL_COLORS.guide,
          }}
          aria-label={label}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
          </svg>
        </span>
      );
  }
};

interface GamepadVisualPreviewProps {
  snapshot: GamepadSnapshotState | null;
  connected: boolean;
  previewPaused: boolean;
  highlightedTarget: GamepadTargetControl | null;
  deadzone?: number;
}

const NEUTRAL_SNAPSHOT: GamepadSnapshotState = {
  buttons: 0,
  leftTrigger: 0,
  rightTrigger: 0,
  thumbLx: 0,
  thumbLy: 0,
  thumbRx: 0,
  thumbRy: 0,
};

export const GamepadVisualPreview: React.FC<GamepadVisualPreviewProps> = ({
  snapshot,
  connected,
  previewPaused,
  highlightedTarget,
  deadzone = 0,
}) => {
  if (!connected) {
    return (
      <div className="input-bindings-gamepad-disconnected">
        {t('inputBindings.noPhysicalGamepad')}
      </div>
    );
  }

  const active = previewPaused ? NEUTRAL_SNAPSHOT : (snapshot ?? NEUTRAL_SNAPSHOT);
  const btn = (mask: number) => (active.buttons & mask) !== 0;

  const ltPct = Math.round((active.leftTrigger / 255) * 100);
  const rtPct = Math.round((active.rightTrigger / 255) * 100);
  const lxOffset = (active.thumbLx / 32768) * 12;
  const lyOffset = -(active.thumbLy / 32768) * 12;
  const rxOffset = (active.thumbRx / 32768) * 12;
  const ryOffset = -(active.thumbRy / 32768) * 12;
  const clampedDeadzone = Math.max(0, Math.min(1, deadzone));
  const leftDeadzoneR = clampedDeadzone * 26;
  const rightDeadzoneR = clampedDeadzone * 25;

  const isTarget = (tKey: GamepadTargetControl) => highlightedTarget === tKey;
  const anyLeftStickTarget =
    isTarget('lxNeg') || isTarget('lxPos') || isTarget('lyPos') || isTarget('lyNeg') || isTarget('ls');
  const anyRightStickTarget =
    isTarget('rxNeg') || isTarget('rxPos') || isTarget('ryPos') || isTarget('ryNeg') || isTarget('rs');

  return (
    <div className={`gp-visual-wrap ${previewPaused ? 'is-paused' : ''}`}>
      {previewPaused && (
        <div className="gp-visual-paused-banner">{t('inputBindings.previewPausedForAssign')}</div>
      )}

      <div className="gp-visual-shoulders-top">
        <div className={`gp-trigger-pill ${isTarget('leftTrigger') ? 'is-target' : ''}`}>
          <span className="gp-trigger-tag" style={{ color: GAMEPAD_CONTROL_COLORS.trigger }}>LT</span>
          <div className="gp-trigger-meter">
            <div
              className="gp-trigger-meter-fill"
              style={{ width: `${ltPct}%`, backgroundColor: GAMEPAD_CONTROL_COLORS.trigger }}
            />
          </div>
          <span className="gp-trigger-pct">{ltPct}%</span>
        </div>
        <div className={`gp-trigger-pill ${isTarget('rightTrigger') ? 'is-target' : ''}`}>
          <span className="gp-trigger-pct">{rtPct}%</span>
          <div className="gp-trigger-meter">
            <div
              className="gp-trigger-meter-fill"
              style={{ width: `${rtPct}%`, backgroundColor: GAMEPAD_CONTROL_COLORS.trigger }}
            />
          </div>
          <span className="gp-trigger-tag" style={{ color: GAMEPAD_CONTROL_COLORS.trigger }}>RT</span>
        </div>
      </div>

      <svg
        className="gp-visual-svg"
        viewBox="0 0 360 236"
        role="img"
        aria-label={t('inputBindings.gamepadPreviewLabel')}
      >
        {/* Shoulder Bumpers (LB / RB) tucked inward inside the top shoulders */}
        <path
          d="M68 30 C72 17, 98 15, 118 19 L114 31 L66 33 Z"
          className={`gp-svg-bumper ${btn(0x0100) ? 'is-pressed' : ''} ${isTarget('lb') ? 'is-target' : ''}`}
          style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.bumper } as React.CSSProperties}
        />
        <text x="93" y="27" textAnchor="middle" className="gp-svg-mini-label">LB</text>

        <path
          d="M292 30 C288 17, 262 15, 242 19 L246 31 L294 33 Z"
          className={`gp-svg-bumper ${btn(0x0200) ? 'is-pressed' : ''} ${isTarget('rb') ? 'is-target' : ''}`}
          style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.bumper } as React.CSSProperties}
        />
        <text x="267" y="27" textAnchor="middle" className="gp-svg-mini-label">RB</text>

        {/* Main Controller Shell with generous bottom clearance */}
        <path
          d="M76 30 C112 23, 248 23, 284 30 C318 36, 340 86, 346 152 C351 200, 326 224, 300 218 C278 212, 264 190, 246 180 L114 180 C96 190, 82 212, 60 218 C34 224, 9 200, 14 152 C20 86, 42 36, 76 30 Z"
          className="gp-svg-body"
        />

        {/* Guide / Back / Start */}
        <g
          className={`gp-svg-btn ${btn(0x0400) ? 'is-pressed' : ''} ${isTarget('guide') ? 'is-target' : ''}`}
          style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.guide } as React.CSSProperties}
        >
          <circle cx="180" cy="62" r="13" className="gp-svg-pad" />
          <path d="M174 56l12 12M186 56l-12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </g>

        <g
          className={`gp-svg-btn ${btn(0x0020) ? 'is-pressed' : ''} ${isTarget('back') ? 'is-target' : ''}`}
          style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.bumper } as React.CSSProperties}
        >
          <circle cx="148" cy="86" r="9" className="gp-svg-pad" />
          <rect x="144" y="82" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </g>

        <g
          className={`gp-svg-btn ${btn(0x0010) ? 'is-pressed' : ''} ${isTarget('start') ? 'is-target' : ''}`}
          style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.bumper } as React.CSSProperties}
        >
          <circle cx="212" cy="86" r="9" className="gp-svg-pad" />
          <path d="M208 83h8M208 86h8M208 89h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </g>

        {/* Left Thumbstick (LS) */}
        <g
          className={`${anyLeftStickTarget ? 'is-target' : ''}`}
          style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.leftStick } as React.CSSProperties}
        >
          <circle
            cx="90"
            cy="80"
            r="26"
            className={`gp-svg-stick-well ${btn(0x0040) ? 'is-pressed' : ''} ${anyLeftStickTarget ? 'is-target' : ''}`}
          />
          {isTarget('lyPos') && <path d="M90 53L95 61H85Z" fill={GAMEPAD_CONTROL_COLORS.leftStick} />}
          {isTarget('lyNeg') && <path d="M90 107L95 99H85Z" fill={GAMEPAD_CONTROL_COLORS.leftStick} />}
          {isTarget('lxNeg') && <path d="M63 80L71 75V85Z" fill={GAMEPAD_CONTROL_COLORS.leftStick} />}
          {isTarget('lxPos') && <path d="M117 80L109 75V85Z" fill={GAMEPAD_CONTROL_COLORS.leftStick} />}
          <circle
            cx={90 + lxOffset}
            cy={80 + lyOffset}
            r="14"
            className={`gp-svg-stick-cap ${btn(0x0040) ? 'is-pressed' : ''}`}
            style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.leftStick } as React.CSSProperties}
          />
          {leftDeadzoneR > 0 && (
            <circle cx="90" cy="80" r={leftDeadzoneR} className="gp-svg-deadzone" />
          )}
        </g>

        {/* D-Pad (4 directions) with clean bottom margin */}
        <g style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.dpad } as React.CSSProperties}>
          <rect x="124" y="126" width="16" height="16" className="gp-svg-dpad-center" />
          <rect
            x="124"
            y="108"
            width="16"
            height="19"
            rx="3"
            className={`gp-svg-dpad-arm ${btn(0x0001) ? 'is-pressed' : ''} ${isTarget('dpadUp') ? 'is-target' : ''}`}
          />
          <rect
            x="124"
            y="141"
            width="16"
            height="19"
            rx="3"
            className={`gp-svg-dpad-arm ${btn(0x0002) ? 'is-pressed' : ''} ${isTarget('dpadDown') ? 'is-target' : ''}`}
          />
          <rect
            x="106"
            y="126"
            width="19"
            height="16"
            rx="3"
            className={`gp-svg-dpad-arm ${btn(0x0004) ? 'is-pressed' : ''} ${isTarget('dpadLeft') ? 'is-target' : ''}`}
          />
          <rect
            x="139"
            y="126"
            width="19"
            height="16"
            rx="3"
            className={`gp-svg-dpad-arm ${btn(0x0008) ? 'is-pressed' : ''} ${isTarget('dpadRight') ? 'is-target' : ''}`}
          />
        </g>

        {/* Right Thumbstick (RS) spaced cleanly below face buttons and above bottom rim */}
        <g
          className={`${anyRightStickTarget ? 'is-target' : ''}`}
          style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.rightStick } as React.CSSProperties}
        >
          <circle
            cx="226"
            cy="138"
            r="25"
            className={`gp-svg-stick-well ${btn(0x0080) ? 'is-pressed' : ''} ${anyRightStickTarget ? 'is-target' : ''}`}
          />
          {isTarget('ryPos') && <path d="M226 112L231 120H221Z" fill={GAMEPAD_CONTROL_COLORS.rightStick} />}
          {isTarget('ryNeg') && <path d="M226 164L231 156H221Z" fill={GAMEPAD_CONTROL_COLORS.rightStick} />}
          {isTarget('rxNeg') && <path d="M200 138L208 133V143Z" fill={GAMEPAD_CONTROL_COLORS.rightStick} />}
          {isTarget('rxPos') && <path d="M252 138L244 133V143Z" fill={GAMEPAD_CONTROL_COLORS.rightStick} />}
          <circle
            cx={226 + rxOffset}
            cy={138 + ryOffset}
            r="13.5"
            className={`gp-svg-stick-cap ${btn(0x0080) ? 'is-pressed' : ''}`}
            style={{ '--gp-active': GAMEPAD_CONTROL_COLORS.rightStick } as React.CSSProperties}
          />
          {rightDeadzoneR > 0 && (
            <circle cx="226" cy="138" r={rightDeadzoneR} className="gp-svg-deadzone" />
          )}
        </g>

        {/* Face Buttons: Y (top), X (left), B (right), A (bottom) */}
        {(
          [
            { key: 'y', label: 'Y', cx: 270, cy: 54, mask: 0x8000, color: GAMEPAD_CONTROL_COLORS.y },
            { key: 'x', label: 'X', cx: 246, cy: 77, mask: 0x4000, color: GAMEPAD_CONTROL_COLORS.x },
            { key: 'b', label: 'B', cx: 294, cy: 77, mask: 0x2000, color: GAMEPAD_CONTROL_COLORS.b },
            { key: 'a', label: 'A', cx: 270, cy: 100, mask: 0x1000, color: GAMEPAD_CONTROL_COLORS.a },
          ] as const
        ).map((face) => (
          <g
            key={face.key}
            className={`gp-svg-face ${btn(face.mask) ? 'is-pressed' : ''} ${isTarget(face.key) ? 'is-target' : ''}`}
            style={{ '--gp-active': face.color } as React.CSSProperties}
          >
            <circle cx={face.cx} cy={face.cy} r="13" className="gp-svg-face-circle" />
            <text x={face.cx} y={face.cy + 4} textAnchor="middle" className="gp-svg-face-letter">
              {face.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
};
