import { PeerAuthenticator } from './peer_auth.ts';

export interface AuthorityTransfer {
  roomId: string;
  epoch: number;
  previousKey: string;
  nextKey: string;
  nextPeerId: string;
  previousSignature: string;
  nextSignature: string;
}

export interface HostCommand {
  roomId: string;
  epoch: number;
  sequence: number;
  kind: 'admit' | 'kick' | 'password';
  targetPeerId?: string;
  targetKey?: string;
  password?: string;
  signature: string;
}

const transferData = (value: AuthorityTransfer) => [
  value.roomId, value.epoch, value.previousKey, value.nextKey, value.nextPeerId,
];
const commandData = (value: HostCommand) => [
  value.roomId, value.epoch, value.sequence, value.kind,
  value.targetPeerId ?? null, value.targetKey ?? null, value.password ?? null,
];

export class RoomAuthority {
  readonly roomId: string;
  readonly rootKey: string;
  currentKey: string;
  epoch = 0;
  commandSequence = Date.now() * 1000;
  private readonly seenCommands = new Set<string>();
  private readonly chain: AuthorityTransfer[] = [];
  private readonly auth: PeerAuthenticator;

  constructor(roomId: string, rootKey: string, auth: PeerAuthenticator) {
    this.roomId = roomId;
    this.rootKey = rootKey;
    this.currentKey = rootKey;
    this.auth = auth;
  }

  isLocalHost(): boolean { return this.auth.publicKey === this.currentKey; }
  isPeerHost(peerId: string): boolean { return this.auth.getKnownKey(peerId) === this.currentKey; }
  history(): AuthorityTransfer[] { return [...this.chain]; }

  async proposeTransfer(nextKey: string, nextPeerId: string): Promise<Omit<AuthorityTransfer, 'nextSignature'>> {
    if (!this.isLocalHost() || !/^04[0-9a-f]{128}$/.test(nextKey) || !nextPeerId) {
      throw new Error('Only the authenticated host may transfer authority');
    }
    const transfer = {
      roomId: this.roomId, epoch: this.epoch + 1,
      previousKey: this.currentKey, nextKey, nextPeerId,
    };
    return { ...transfer, previousSignature: await this.auth.signControl('transfer', transferData({
      ...transfer, previousSignature: '', nextSignature: '',
    })) };
  }

  async acceptTransfer(proposal: Omit<AuthorityTransfer, 'nextSignature'>): Promise<AuthorityTransfer> {
    if (proposal.nextKey !== this.auth.publicKey || proposal.roomId !== this.roomId ||
        proposal.previousKey !== this.currentKey || proposal.epoch !== this.epoch + 1 ||
        !await this.auth.verifyControl('transfer', transferData({ ...proposal, nextSignature: '' }),
          proposal.previousSignature, this.currentKey)) {
      throw new Error('Invalid ownership transfer');
    }
    const nextSignature = await this.auth.signControl('transfer-accept',
      [...transferData({ ...proposal, nextSignature: '' }), proposal.previousSignature]);
    return { ...proposal, nextSignature };
  }

  async applyTransfer(transfer: AuthorityTransfer): Promise<boolean> {
    if (transfer.roomId !== this.roomId || transfer.epoch !== this.epoch + 1 ||
        transfer.previousKey !== this.currentKey || !transfer.nextPeerId ||
        !/^04[0-9a-f]{128}$/.test(transfer.nextKey)) return false;
    if (!await this.auth.verifyControl('transfer', transferData(transfer),
      transfer.previousSignature, this.currentKey)) return false;
    if (!await this.auth.verifyControl('transfer-accept',
      [...transferData(transfer), transfer.previousSignature], transfer.nextSignature, transfer.nextKey)) return false;
    this.chain.push(transfer);
    this.currentKey = transfer.nextKey;
    this.epoch = transfer.epoch;
    this.commandSequence = Date.now() * 1000;
    this.seenCommands.clear();
    return true;
  }

  async importChain(chain: AuthorityTransfer[]): Promise<boolean> {
    if (!Array.isArray(chain) || chain.length > 100) return false;
    for (const transfer of chain) {
      if (transfer.epoch <= this.epoch) continue;
      if (!await this.applyTransfer(transfer)) return false;
    }
    return true;
  }

  async makeCommand(kind: HostCommand['kind'], fields: Partial<HostCommand>): Promise<HostCommand> {
    if (!this.isLocalHost()) throw new Error('Only the authenticated host may issue room commands');
    const command: HostCommand = {
      roomId: this.roomId, epoch: this.epoch, sequence: ++this.commandSequence,
      kind, ...fields, signature: '',
    };
    command.signature = await this.auth.signControl('host-command', commandData(command));
    return command;
  }

  async verifyCommand(command: HostCommand): Promise<boolean> {
    if (!command || command.roomId !== this.roomId || command.epoch !== this.epoch ||
        !Number.isSafeInteger(command.sequence) || command.sequence <= 0 ||
        !['admit', 'kick', 'password'].includes(command.kind)) return false;
    const identifier = `${command.epoch}:${command.sequence}`;
    if (this.seenCommands.has(identifier)) return false;
    if (command.kind === 'password' && (typeof command.password !== 'string' || command.password.length > 128)) return false;
    if (command.kind !== 'password' && (!command.targetPeerId || !command.targetKey)) return false;
    if (!await this.auth.verifyControl('host-command', commandData(command), command.signature, this.currentKey)) return false;
    this.seenCommands.add(identifier);
    this.commandSequence = Math.max(this.commandSequence, command.sequence);
    return true;
  }
}
