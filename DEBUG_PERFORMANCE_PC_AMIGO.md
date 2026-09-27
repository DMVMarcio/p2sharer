# DOCUMENTO DE INVESTIGAÇÃO E DIAGNÓSTICO: PERFORMANCE, CPU E VENTOINHAS (PC EDUARDO)

> **Destinatário:** Antigravity AI Assistant executando no PC do Eduardo (ou desenvolvedor responsável).  
> **Repositório:** `P2Sharer` (Tauri v2 + Rust + React + WebRTC / Trystero + WASAPI Loopback).  
> **Data:** 27 de Setembro de 2026.

---

> [!WARNING]
> ### ⚠️ AVISO IMPORTANTE: HIPÓTESES EM ABERTO (NADA CONFIRMADO COMO CAUSA ÚNICA)
> As causas técnicas, teorias e fluxos descritos neste documento são **fortes suspeitas e hipóteses levantadas a partir de telemetria inicial, mas NÃO são certezas absolutas**.  
> **Sua missão neste computador NÃO é apenas aplicar uma suposta "receita pronta", mas sim conduzir uma investigação aberta e aprofundada de todo o sistema.** Você deve analisar **outros possíveis problemas e subsistemas** (áudio, WebRTC, WebView2, drivers, encoders, timers de sistema, IPC) que possam estar causando ou contribuindo para os sintomas.

---

## 1. Contexto do Hardware e Sintomas Observados

Nesta máquina (Eduardo - usuário `NormadM` nos relatórios de telemetria), o aplicativo `P2Sharer` apresenta 3 comportamentos anômalos críticos que precisam ser investigados e solucionados:

1. **Consumo Excessivo e Queda Severa de FPS em Jogos durante a Transmissão:**
   - Ao iniciar o compartilhamento de tela, as ventoinhas da CPU e da GPU disparam imediatamente em velocidade máxima.
   - Em jogos abertos simultaneamente na mesma máquina, ocorre queda severa de FPS (stuttering e engasgos), o que **não** ocorre ao usar programas concorrentes como Discord, OBS ou Moonlight.
2. **Consumo Residual após Parar o Compartilhamento:**
   - Ao clicar em "Parar Compartilhamento", o processo `P2Sharer` (especificamente o binário Rust `p2sharer.exe`) **não** volta para o repouso. Ele permanece consumindo continuamente ~100% de um núcleo de CPU (~3% a 4% no Gerenciador de Tarefas de uma CPU de 32 threads).
   - As ventoinhas do computador **não param** de soprar no máximo e o clock da CPU fica travado no Turbo Boost máximo (**4501 MHz** em todos os núcleos).
   - A ventoinha da GPU (NVIDIA RTX 3080 Ti) permanece travada em **47%** contínuos.
3. **Consumo Acumulativo a Cada Tentativa (Thread / Resource Leak):**
   - A cada ciclo de **Iniciar Compartilhamento $\rightarrow$ Parar Compartilhamento**, o consumo residual do `P2Sharer` **acumula**:
     - 1º ciclo: ~4% residual (1 core a 100%)
     - 2º ciclo: ~8% residual (2 cores a 100%)
     - 3º ciclo: ~12% residual (3 cores a 100%)
     - ... atingindo mais de **20% de CPU global** no Gerenciador de Tarefas com o compartilhamento desligado!

---

## 2. Dados Extraídos da Telemetria Real Comparativa

Os relatórios gerados pela telemetria embutida do app (`relatorios/` no repositório) revelaram os seguintes dados reais:

### PC Eduardo (`relatorios/eduardo-compartilhando.txt` e `eduardo-depois.txt`)
- **Hardware:** CPU 32 núcleos lógicos @ 4501 MHz, 128 GB RAM, GPU NVIDIA GeForce RTX 3080 Ti (12 GB VRAM).
- **Durante a Transmissão:**
  - `p2sharer.exe` (Rust Backend): **217.2% de CPU**, **119 threads**.
  - `msedgewebview2.exe` (Processo GPU): **48.4% de CPU**, **263 threads**.
  - `msedgewebview2.exe` (Renderer): **75.0% de CPU**, 52 threads.
  - GPU 3D: 31%, NVENC Encoder: 34%, GPU Fan: **47%**, Power: 36.4 W.
  - Cores individuais em alta: Core 7 em 67.3% @ 4501 MHz, Core 9 em 63.7% @ 4501 MHz.
- **Após Parar a Transmissão:**
  - `p2sharer.exe` (Rust Backend): **108.7% de CPU** (1 núcleo inteiro em 100%), **76 threads**.
  - GPU Fan: **47%** (continua soprando sem parar).
  - Clock da CPU: cravado em **4501 MHz**.
  - Subsystemas reportados: `Captura de Tela Ativa: NÃO`, `Capturador Nativo WGC: INATIVO`, `Captura de Áudio: INATIVO`.

### Comparativo com o PC do Márcio (`relatorios/marcio-depois.txt`)
- CPU 16 núcleos lógicos, GPU RTX 5070.
- Após parar transmissão: `p2sharer.exe` caiu para **7.8% de CPU** e **48 threads** (27 threads foram limpas com sucesso). Ventoinha em 0%.

---

## 3. Hipóteses em Aberto para Investigação

Você **deve avaliar todas** as seguintes áreas, pois o problema pode estar em uma delas ou na combinação de várias:

### Hipótese 1: O Pipeline de Vídeo (Cópia VRAM $\rightarrow$ RAM + Compressão JPEG na CPU)
- **O que investigar em [`src-tauri/src/screen_sources.rs`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src-tauri/src/screen_sources.rs):**
  - O Windows Graphics Capture (WGC) captura a textura na GPU.
  - O código atualmente lê o buffer via `as_nopadding_buffer`, copiando megabytes por frame da VRAM para a RAM via PCIe.
  - Em seguida, roda redimensionamento bilinear e compressão JPEG por software na CPU (`FastJpegEncoder`) 60 vezes por segundo.
  - Esse fluxo pode ser o responsável direto pela queda de FPS em jogos (por saturar largura de banda PCIe e competir por CPU).
  - Além disso, avaliar se a crate `windows-capture` ou seus laços Win32/WinRT mantêm sessões `Direct3D11CaptureFramePool` ou threads zumbis ativas ao parar.

### Hipótese 2: Subsistema de Áudio WASAPI e Timers de Alta Precisão
- **O que investigar em [`src-tauri/src/audio_loopback.rs`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src-tauri/src/audio_loopback.rs):**
  - O loop de captura WASAPI utiliza chamadas a `timeBeginPeriod(1)`. Quando ativo, o Windows altera a resolução do timer global para 1ms, o que impede núcleos de processadores modernos de entrarem em C-States de baixo consumo e crava o clock no máximo (4501 MHz).
  - Investigar se `timeEndPeriod(1)` está sendo chamado em todos os caminhos de saída.
  - Investigar se a rotina `discover_active_non_excluded_pids` ou `sysinfo::System::refresh_processes` dentro do loop de áudio consome ciclos excessivos em CPUs de muitos núcleos (32 threads).
  - Investigar se o laço de eventos do `WaitForMultipleObjects` ou buffers FIFO de áudio continuam rodando ou acumulando dados após o stop.

### Hipótese 3: Processo GPU do WebView2 e WebRTC Hardware Encoder
- **O que investigar no Frontend e WebView2:**
  - O processo de GPU do WebView2 registrou **263 threads** e quase 50% de CPU.
  - Investigar as flags de inicialização em `src-tauri/src/lib.rs` (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`).
  - Investigar se transceivers WebRTC em [`src/p2p/group_room.ts`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src/p2p/group_room.ts) continuam codificando ou se o encoder de hardware NVENC do Chromium permanece engajado após `stopStream()`.

### Hipótese 4: Localhost WebSocket e Tráfego IPC
- **O que investigar em [`src-tauri/src/screen_sources.rs`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src-tauri/src/screen_sources.rs) e [`src/video/native_video_bridge.ts`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src/video/native_video_bridge.ts):**
  - O canal WebSocket na porta 49153 transporta dezenas de megabytes por segundo de JPEG.
  - Investigar se conexões WebSocket antigas permanecem abertas no servidor tokio ao parar e iniciar repetidamente, acumulando conexões e tasks de envio em broadcast.

---

## 4. Diretrizes de Investigação e Validação Prática

Ao atuar nesta máquina, proceda com método empírico:

1. **Profiling Ativo das Threads e Processos:**
   Execute no PowerShell desta máquina:
   ```powershell
   Get-Process p2sharer | Select-Object Id, CPU, Threads, TotalProcessorTime
   ```
   Utilize ferramentas como o *Process Explorer (Sysinternals)* ou PowerShell para ver a pilha de chamadas (*Call Stack*) exata das threads do `p2sharer.exe` que estão consumindo CPU.
2. **Isolar Vídeo vs Áudio:**
   - Teste iniciar transmissão apenas de vídeo (sem áudio) e verifique o comportamento da CPU e ventoinhas.
   - Teste iniciar captura de áudio isolada e verifique o comportamento.
   - Isso isolará instantaneamente qual dos dois subsistemas é o principal culpado pelo vazamento residual.
3. **Avaliar Captura Nativa vs Direct GPU (Zero-Copy):**
   - Avalie testar a alternativa de captura direta via Chromium (`startDisplayMediaCapture` no `native_video_bridge.ts`) para ver se a queda de FPS em jogos e o uso de CPU desaparecem quando se elimina a compressão JPEG em software.
4. **Verificar Desligamento Determinístico:**
   - Certifique-se de que ao parar o compartilhamento, todas as threads de background terminem de fato (retornando a contagem de threads e uso de CPU do `p2sharer.exe` para os níveis basais de repouso).
   - Teste 5 a 10 ciclos consecutivos de Iniciar e Parar e comprove que o uso de CPU **não se acumula** mais.

---
*Fim do documento de diagnóstico.*
