import type { HostCommand } from './room_authority.ts';

const encoder = new TextEncoder();

export function latestAdminCommand(commands: HostCommand[], epoch: number, key: string): HostCommand | undefined {
  return commands.filter((command) => command.epoch === epoch && command.targetKey === key &&
    (command.kind === 'admin' || command.kind === 'revoke-admin'))
    .sort((left, right) => right.sequence - left.sequence)[0];
}

export async function roomStateFingerprint(epoch: number, commands: HostCommand[]): Promise<string> {
  const entries = commands.map((command) => [command.epoch, command.sequence, command.signature]);
  entries.sort((left, right) => Number(left[0]) - Number(right[0]) ||
    Number(left[1]) - Number(right[1]) || String(left[2]).localeCompare(String(right[2])));
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([epoch, entries])));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
