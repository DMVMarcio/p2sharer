import { t } from '../i18n/index.ts';
import protocolLabels from '../i18n/protocol.json' with { type: 'json' };
import type React from 'react';
import { FileText, Network, Globe, Palette } from 'lucide-react';
import { WhiteboardModel } from './whiteboard_model.ts';
import { SiYoutube } from 'react-icons/si';
import { NotepadModel, YouTubeModel, type RoomAppModel, type RoomAppModelContext } from './models.ts';
import { TunnelModel } from './tunnel_model.ts';
import { BrowserModel } from './browser_model.ts';

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
  loadView: () => import('./NotepadApp').then((module) => ({ default: module.NotepadApp })) });
registerRoomApp({ kind: 'youtube', label: 'YouTube',
  get description() { return t("message.22dea6587836"); },
  icon: SiYoutube, iconStyle: 'filled', bannerClass: 'youtube', createModel: (context) => new YouTubeModel(context),
  loadView: () => import('./YouTubeApp').then((module) => ({ default: module.YouTubeApp })) });
registerRoomApp({ kind: 'tunnels', protocolLabel: 'Tunnels', get label() { return t('tunnels.title'); },
  get description() { return t('tunnels.description'); }, icon: Network, bannerClass: 'tunnels', detachable: false,
  createModel: (context) => new TunnelModel(context),
  loadView: () => import('./TunnelApp').then((module) => ({ default: module.TunnelApp })) });
registerRoomApp({ kind: 'browser', protocolLabel: 'Browser', get label() { return t('browser.title'); },
  get description() { return t('browser.description'); }, icon: Globe, bannerClass: 'browser',
  createModel: context => new BrowserModel(context),
  loadView: () => import('./BrowserApp').then(module => ({ default: module.BrowserApp })) });

registerRoomApp({ kind: 'whiteboard', protocolLabel: 'Whiteboard', get label() { return t('whiteboard.title'); },
  get description() { return t('whiteboard.description'); }, icon: Palette, bannerClass: 'whiteboard',
  createModel: context => new WhiteboardModel(context),
  loadView: () => import('./WhiteboardApp').then(module => ({ default: module.WhiteboardApp })) });
