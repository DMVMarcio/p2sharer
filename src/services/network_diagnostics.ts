import { invoke } from '../platform/commands.ts';

export interface NetworkDiagnosticResult {
  nat_type: 'cone' | 'symmetric' | 'blocked' | 'unknown';
  nat_description: string;
  public_ip: string | null;
  cgnat_detected: boolean;
  double_nat_detected: boolean;
  cgnat_details: string | null;
  upnp_available: boolean;
  upnp_gateway: string | null;
  upnp_external_ip: string | null;
  upnp_port_mapped: boolean;
  stun_latency_ms: number | null;
  recommendation: 'optimal' | 'moderate' | 'restricted' | 'blocked';
}

export async function runNetworkDiagnostics(): Promise<NetworkDiagnosticResult> {
  return invoke<NetworkDiagnosticResult>('run_network_diagnostics');
}
