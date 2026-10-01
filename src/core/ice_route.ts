export interface IceStat {
  id: string;
  type: string;
  selectedCandidatePairId?: string;
  selected?: boolean;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  candidateType?: string;
  protocol?: string;
  bytesSent?: number;
  bytesReceived?: number;
  availableOutgoingBitrate?: number;
  packetsDiscardedOnSend?: number;
}

export interface IceRoute {
  connectionType: 'P2P Direto' | 'TURN Relay' | 'Rota desconhecida';
  pingMs: number | null;
}

export function selectedIcePair(reports: Iterable<IceStat>): { pair: IceStat; local?: IceStat; remote?: IceStat } | null {
  const byId = new Map<string, IceStat>();
  let selectedPairId: string | undefined;
  let selectedPair: IceStat | undefined;
  let nominatedPair: IceStat | undefined;
  for (const report of reports) {
    byId.set(report.id, report);
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      selectedPairId = report.selectedCandidatePairId;
    } else if (report.type === 'candidate-pair') {
      if (report.selected) selectedPair = report;
      if (report.nominated && report.state === 'succeeded') nominatedPair = report;
    }
  }
  const pair = (selectedPairId && byId.get(selectedPairId)) || selectedPair || nominatedPair;
  if (!pair) return null;
  return { pair, local: pair.localCandidateId ? byId.get(pair.localCandidateId) : undefined,
    remote: pair.remoteCandidateId ? byId.get(pair.remoteCandidateId) : undefined };
}

export function selectedIceRoute(reports: Iterable<IceStat>): IceRoute {
  const selected = selectedIcePair(reports);
  if (!selected?.pair.localCandidateId || !selected.pair.remoteCandidateId) {
    return { connectionType: 'Rota desconhecida', pingMs: null };
  }
  const { pair, local, remote } = selected;
  const connectionType = !local || !remote ? 'Rota desconhecida' :
    local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'TURN Relay' : 'P2P Direto';
  return { connectionType, pingMs: typeof pair.currentRoundTripTime === 'number' ?
    Math.round(pair.currentRoundTripTime * 1000) : null };
}
