import { t } from '../i18n/index.ts';
import protocolLabels from '../i18n/protocol.json' with { type: 'json' };
import type React from 'react';
import { FileText, Network, Globe, Palette, Grid3x3, Crown, CircleDot } from 'lucide-react';
import { WhiteboardModel } from './whiteboard/whiteboard_model.ts';
import { SiYoutube, SiTwitch } from 'react-icons/si';
import { NotepadModel, YouTubeModel, TwitchModel, type RoomAppModel, type RoomAppModelContext } from './models.ts';
import { TunnelModel } from './tunnels/tunnel_model.ts';
import { BrowserModel } from './browser/browser_model.ts';
import { TicTacToeModel, ChessModel, CheckersModel } from './games/board_game_model.ts';

export interface RoomAppViewProps { instanceId: string; compact?: boolean }
export interface RoomAppDefinition {
  kind: string;
  label: string;
  /** Stable signed wire text; UI labels may change with the local language. */
  protocolLabel?: string;
  description?: string;
  icon?: React.ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  iconStyle?: 'outline' | 'filled';
  bannerClass?: string;
  bannerImage?: string;
  detachable?: boolean;
  desktopOnly?: boolean;
  createModel(context: RoomAppModelContext): RoomAppModel;
  loadView(): Promise<{ default: React.ComponentType<RoomAppViewProps> }>;
}

const definitions = new Map<string, RoomAppDefinition>();
const listeners = new Set<() => void>();

export function registerRoomApp(definition: RoomAppDefinition): void {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(definition.kind) || definitions.has(definition.kind))
    throw new Error(`Invalid or duplicate room app: ${definition.kind}`);
  definitions.set(definition.kind, definition);
  listeners.forEach((listener) => listener());
}

export function onRoomAppRegistryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRoomApp(kind: string): RoomAppDefinition | undefined { return definitions.get(kind); }
export function listRoomApps(): RoomAppDefinition[] { return [...definitions.values()]; }
export function isRoomAppKind(value: unknown): value is string {
  return typeof value === 'string' && definitions.has(value);
}

registerRoomApp({ kind: 'notepad', protocolLabel: protocolLabels.notepad, get label() { return t("message.753e28f9f62e"); },
  get description() { return t("message.db228884dc9d"); },
  icon: FileText, bannerClass: 'notepad', createModel: (context) => new NotepadModel(context),
  loadView: () => import('./notepad/NotepadApp').then((module) => ({ default: module.NotepadApp })) });
registerRoomApp({ kind: 'youtube', label: 'YouTube',
  get description() { return t("message.22dea6587836"); },
  icon: SiYoutube, iconStyle: 'filled', bannerClass: 'youtube', createModel: (context) => new YouTubeModel(context),
  loadView: () => import('./youtube/YouTubeApp').then((module) => ({ default: module.YouTubeApp })) });
registerRoomApp({ kind: 'twitch', label: 'Twitch',
  get description() { return t('twitch.description'); },
  icon: SiTwitch, iconStyle: 'filled', bannerClass: 'twitch', createModel: (context) => new TwitchModel(context),
  loadView: () => import('./twitch/TwitchApp').then((module) => ({ default: module.TwitchApp })) });
registerRoomApp({ kind: 'tunnels', protocolLabel: 'Tunnels', get label() { return t('tunnels.title'); },
  get description() { return t('tunnels.description'); }, icon: Network, bannerClass: 'tunnels', detachable: false, desktopOnly: true,
  createModel: (context) => new TunnelModel(context),
  loadView: () => import('./tunnels/TunnelApp').then((module) => ({ default: module.TunnelApp })) });
registerRoomApp({ kind: 'browser', protocolLabel: 'Browser', get label() { return t('browser.title'); },
  get description() { return t('browser.description'); }, icon: Globe, bannerClass: 'browser', desktopOnly: true,
  createModel: context => new BrowserModel(context),
  loadView: () => import('./browser/BrowserApp').then(module => ({ default: module.BrowserApp })) });

registerRoomApp({ kind: 'whiteboard', protocolLabel: 'Whiteboard', get label() { return t('whiteboard.title'); },
  get description() { return t('whiteboard.description'); }, icon: Palette, bannerClass: 'whiteboard',
  createModel: context => new WhiteboardModel(context),
  loadView: () => import('./whiteboard/WhiteboardApp').then(module => ({ default: module.WhiteboardApp })) });

registerRoomApp({ kind: 'tictactoe', protocolLabel: 'Tic-Tac-Toe', get label() { return t('tictactoe.title'); },
  get description() { return t('tictactoe.description'); }, icon: Grid3x3, bannerClass: 'tictactoe',
  createModel: context => new TicTacToeModel(context),
  loadView: () => import('./games/tictactoe/TicTacToeApp').then(module => ({ default: module.TicTacToeApp })) });

registerRoomApp({ kind: 'chess', protocolLabel: 'Chess', get label() { return t('chess.title'); },
  get description() { return t('chess.description'); }, icon: Crown, bannerClass: 'chess',
  createModel: context => new ChessModel(context),
  loadView: () => import('./games/chess/ChessApp').then(module => ({ default: module.ChessApp })) });

registerRoomApp({ kind: 'checkers', protocolLabel: 'Checkers', get label() { return t('checkers.title'); },
  get description() { return t('checkers.description'); }, icon: CircleDot, bannerClass: 'checkers',
  createModel: context => new CheckersModel(context),
  loadView: () => import('./games/checkers/CheckersApp').then(module => ({ default: module.CheckersApp })) });
