import type React from 'react';
import { FileText } from 'lucide-react';
import { SiYoutube } from 'react-icons/si';
import { NotepadModel, YouTubeModel, type RoomAppModel, type RoomAppModelContext } from './models.ts';

export interface RoomAppViewProps { instanceId: string; compact?: boolean }
export interface RoomAppDefinition {
  kind: string;
  label: string;
  description?: string;
  icon?: React.ComponentType<{ size?: number; strokeWidth?: number }>;
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

registerRoomApp({ kind: 'notepad', label: 'Bloco de notas',
  description: 'Escreva em tempo real com todos na sala e abra ou salve notas no seu computador.',
  icon: FileText, bannerClass: 'notepad', createModel: (context) => new NotepadModel(context),
  loadView: () => import('./NotepadApp').then((module) => ({ default: module.NotepadApp })) });
registerRoomApp({ kind: 'youtube', label: 'YouTube',
  description: 'Monte uma fila de vídeos e playlists para assistir em sincronia.',
  icon: SiYoutube, bannerClass: 'youtube', createModel: (context) => new YouTubeModel(context),
  loadView: () => import('./YouTubeApp').then((module) => ({ default: module.YouTubeApp })) });
