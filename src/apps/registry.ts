import { t } from '../i18n/index.ts';
import protocolLabels from '../i18n/protocol.json' with { type: 'json' };
import type React from 'react';
import { FileText } from 'lucide-react';
import { SiYoutube } from 'react-icons/si';
import { NotepadModel, YouTubeModel, type RoomAppModel, type RoomAppModelContext } from './models.ts';

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
