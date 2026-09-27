import { invoke } from '@tauri-apps/api/core';
import type { SystemTelemetryReport, TelemetryEvent } from '../core/types.ts';

export class TelemetryService {
  private static instance: TelemetryService | null = null;
  private events: TelemetryEvent[] = [];
  private maxEvents: number = 200;
  private latestReport: SystemTelemetryReport | null = null;
  private listeners: Set<(report: SystemTelemetryReport) => void> = new Set();
  private eventListeners: Set<(event: TelemetryEvent) => void> = new Set();
  private pollingIntervalId: number | null = null;

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  private constructor() {
    this.logEvent('SYSTEM', 'Serviço de Telemetria e Diagnóstico inicializado');
  }

  public logEvent(
    category: TelemetryEvent['category'],
    message: string,
    data?: unknown
  ): void {
    const evt: TelemetryEvent = {
      timestamp: Date.now(),
      category,
      message,
      data,
    };
    this.events.unshift(evt);
    if (this.events.length > this.maxEvents) {
      this.events.pop();
    }
    this.eventListeners.forEach((fn) => {
      try {
        fn(evt);
      } catch {}
    });
  }

  public getEvents(): TelemetryEvent[] {
    return [...this.events];
  }

  public clearEvents(): void {
    this.events = [];
    this.logEvent('SYSTEM', 'Histórico de eventos de telemetria limpo');
  }

  public getLatestReport(): SystemTelemetryReport | null {
    return this.latestReport;
  }

  public async fetchReport(): Promise<SystemTelemetryReport | null> {
    try {
      const report = await invoke<SystemTelemetryReport>('get_system_telemetry');
      this.latestReport = report;
      this.listeners.forEach((fn) => {
        try {
          fn(report);
        } catch {}
      });
      return report;
    } catch (err) {
      console.warn('[TelemetryService] Failed to query telemetry:', err);
      return null;
    }
  }

  public startPolling(intervalMs: number = 1000): void {
    if (this.pollingIntervalId !== null) return;
    this.fetchReport();
    this.pollingIntervalId = window.setInterval(() => {
      this.fetchReport();
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }

  public subscribeReport(fn: (report: SystemTelemetryReport) => void): () => void {
    this.listeners.add(fn);
    if (this.latestReport) {
      fn(this.latestReport);
    }
    return () => this.listeners.delete(fn);
  }

  public subscribeEvents(fn: (event: TelemetryEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  public exportMarkdownReport(clientContext?: {
    username?: string;
    roomCode?: string;
    isSharing?: boolean;
    webrtcStats?: unknown;
  }): string {
    const report = this.latestReport;
    const nowStr = new Date().toISOString();

    let md = `# RELATÓRIO DE TELEMETRIA P2SHARER\n`;
    md += `**Gerado em:** ${nowStr}\n`;
    if (clientContext?.username) md += `**Usuário:** ${clientContext.username}\n`;
    if (clientContext?.roomCode) md += `**Sala:** ${clientContext.roomCode}\n`;
    if (clientContext?.isSharing !== undefined) {
      md += `**Transmitindo tela:** ${clientContext.isSharing ? 'SIM (Ao Vivo)' : 'NÃO (Inativo)'}\n`;
    }
    md += `\n---\n\n`;

    if (!report) {
      md += `*Nenhum relatório de hardware pôde ser obtido.*\n`;
      return md;
    }

    // 1. Resumo do Sistema
    md += `## 1. Resumo Geral de Recursos\n\n`;
    md += `- **CPU Global:** ${report.cpu_global_pct.toFixed(1)}%\n`;
    md += `- **CPU Temperatura:** ${report.cpu_temperature_c ? `${report.cpu_temperature_c.toFixed(0)}°C` : 'N/D (Não exposto pelo ACPI)'}\n`;
    md += `- **Memória RAM:** ${(report.memory_used_mb / 1024).toFixed(1)} GB / ${(report.memory_total_mb / 1024).toFixed(1)} GB (${((report.memory_used_mb / Math.max(1, report.memory_total_mb)) * 100).toFixed(0)}%)\n`;
    md += `- **Total de CPU consumido pelo P2Sharer:** ${report.total_p2sharer_cpu_pct.toFixed(1)}%\n`;
    md += `- **Total de RAM consumido pelo P2Sharer:** ${report.total_p2sharer_memory_mb.toFixed(1)} MB\n`;
    md += `- **Total de Threads do P2Sharer:** ${report.total_p2sharer_threads}\n\n`;

    // 2. GPU Telemetry
    md += `## 2. Placa de Vídeo (GPU)\n\n`;
    if (report.gpu) {
      const g = report.gpu;
      md += `- **Modelo:** ${g.name}\n`;
      md += `- **Fonte da Consulta:** ${g.query_source}\n`;
      md += `- **Temperatura da GPU:** ${g.temperature_c !== undefined ? `${g.temperature_c}°C` : 'N/D'}\n`;
      md += `- **Velocidade da Ventoinha (Fan Speed):** ${g.fan_speed_pct !== undefined ? `${g.fan_speed_pct}%` : 'N/D'}\n`;
      md += `- **Uso da GPU (3D Core):** ${g.utilization_gpu_pct !== undefined ? `${g.utilization_gpu_pct}%` : 'N/D'}\n`;
      md += `- **Codificador de Vídeo (NVENC/Encoder):** ${g.utilization_encoder_pct !== undefined ? `${g.utilization_encoder_pct}%` : 'N/D'}\n`;
      md += `- **Decodificador de Vídeo (NVDEC/Decoder):** ${g.utilization_decoder_pct !== undefined ? `${g.utilization_decoder_pct}%` : 'N/D'}\n`;
      md += `- **Consumo de Energia (Power Draw):** ${g.power_watts !== undefined ? `${g.power_watts.toFixed(1)} W` : 'N/D'}\n`;
      if (g.memory_used_mb !== undefined && g.memory_total_mb !== undefined) {
        md += `- **VRAM Usada:** ${g.memory_used_mb} MB / ${g.memory_total_mb} MB\n`;
      }
    } else {
      md += `*Nenhuma GPU dedicada NVIDIA detectada via nvidia-smi (GPU integrada ou AMD/Intel).*\n`;
    }
    md += `\n`;

    // 3. Processos do P2Sharer e WebView2
    md += `## 3. Processos do P2Sharer e WebView2\n\n`;
    md += `| PID | Função / Papel | CPU % | RAM (MB) | Threads | Tempo Ativo |\n`;
    md += `| :--- | :--- | :---: | :---: | :---: | :---: |\n`;
    report.p2sharer_processes.forEach((p) => {
      const mins = Math.floor(p.run_time_secs / 60);
      const secs = p.run_time_secs % 60;
      const timeStr = `${mins}m ${secs}s`;
      md += `| ${p.pid} | ${p.role} | ${p.cpu_pct.toFixed(1)}% | ${p.memory_mb.toFixed(1)} | ${p.threads} | ${timeStr} |\n`;
    });
    md += `\n`;

    // 4. Núcleos da CPU (Cores Breakdown)
    md += `## 4. Distribuição por Núcleo da CPU\n\n`;
    md += `| Núcleo | Uso % | Clock (MHz) |\n`;
    md += `| :---: | :---: | :---: |\n`;
    report.cpu_cores.forEach((c) => {
      md += `| Core ${c.id} | ${c.usage_pct.toFixed(1)}% | ${c.frequency_mhz} MHz |\n`;
    });
    md += `\n`;

    // 5. Subsistemas Internos
    md += `## 5. Estado dos Subsistemas Internos\n\n`;
    md += `- **Captura de Tela Ativa:** ${report.subsystems.is_screen_capturing ? 'SIM' : 'NÃO'}\n`;
    md += `- **Capturador Nativo WGC:** ${report.subsystems.active_wgc ? 'ATIVO' : 'INATIVO'}\n`;
    md += `- **Porta WebSocket de Vídeo:** ${report.subsystems.ws_port}\n`;
    md += `- **Captura de Áudio (WASAPI Loopback):** ${report.subsystems.is_audio_capturing ? 'ATIVO' : 'INATIVO'}\n\n`;

    // 6. Últimos Eventos Registrados
    md += `## 6. Histórico Recente de Ações (Linha do Tempo)\n\n`;
    if (this.events.length === 0) {
      md += `*Nenhum evento registrado recentemente.*\n`;
    } else {
      md += `| Horário | Categoria | Mensagem |\n`;
      md += `| :--- | :---: | :--- |\n`;
      this.events.slice(0, 40).forEach((e) => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        md += `| ${time} | ${e.category} | ${e.message} |\n`;
      });
    }

    return md;
  }
}

export const telemetryService = TelemetryService.getInstance();
