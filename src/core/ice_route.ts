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
}

export interface IceRoute {
  connectionType: 'P2P Direto' | 'TURN Relay' | 'Rota desconhecida';
  pingMs: number | null;
}

export function selectedIceRoute(reports: Iterable<IceStat>): IceRoute {
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
  if (!pair || !pair.localCandidateId || !pair.remoteCandidateId) {
    return { connectionType: 'Rota desconhecida', pingMs: null };
  }
  const local = byId.get(pair.localCandidateId);
  const remote = byId.get(pair.remoteCandidateId);
  const connectionType = !local || !remote ? 'Rota desconhecida' :
    local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'TURN Relay' : 'P2P Direto';
  return { connectionType, pingMs: typeof pair.currentRoundTripTime === 'number' ?
    Math.round(pair.currentRoundTripTime * 1000) : null };
}
