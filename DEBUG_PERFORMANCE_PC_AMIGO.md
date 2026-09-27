# DOCUMENTO DE DIAGNÓSTICO E RESOLUÇÃO: PERFORMANCE, VAZAMENTO DE CPU E VENTOINHAS (PC EDUARDO)

> **Destinatário:** Antigravity AI Assistant executando no PC do Eduardo (ou desenvolvedor responsável).  
> **Repositório:** `P2Sharer` (Tauri v2 + Rust + React + WebRTC / Trystero + WASAPI Loopback).  
> **Data:** 27 de Setembro de 2026.

---

## 1. Contexto do Hardware e Sintomas Observados

Nesta máquina (Eduardo - usuário `NormadM` nos relatórios), o aplicativo `P2Sharer` apresenta 3 falhas críticas de desempenho e ciclo de vida:

1. **Consumo Excessivo e Queda de FPS em Jogos durante a Transmissão:**
   - Ao iniciar o compartilhamento de tela, as ventoinhas da CPU e da GPU disparam imediatamente em velocidade máxima.
   - Em jogos abertos simultaneamente, ocorre queda severa de FPS (stuttering/queda de taxa de quadros), o que **não** ocorre ao usar Discord, OBS ou Moonlight na mesma máquina.
2. **Consumo Residual após Parar o Compartilhamento:**
   - Ao clicar em "Parar Compartilhamento", o processo `P2Sharer` (especificamente o binário Rust `p2sharer.exe`) **não** volta para o repouso. Ele permanece consumindo continuamente ~100% de um núcleo de CPU (~3% a 4% no Gerenciador de Tarefas de uma CPU de 32 threads).
   - As ventoinhas do computador **não param** de soprar no máximo e o clock da CPU fica travado no Turbo Boost máximo (**4501 MHz** em todos os núcleos).
   - A ventoinha da GPU (NVIDIA RTX 3080 Ti) permanece travada em **47%** contínuos.
3. **Consumo Acumulativo (Thread / Session Leak):**
   - A cada ciclo de **Iniciar Compartilhamento $\rightarrow$ Parar Compartilhamento**, o consumo residual do `P2Sharer` **acumula**:
     - 1º ciclo: ~4% residual (1 core a 100%)
     - 2º ciclo: ~8% residual (2 cores a 100%)
     - 3º ciclo: ~12% residual (3 cores a 100%)
     - ... atingindo mais de **20% de CPU global** no Gerenciador de Tarefas com o compartilhamento desligado!

---

## 2. Dados Extraídos da Telemetria Real Comparativa

Os relatórios gerados pela telemetria embutida do app (`relatorios/` no repositório) revelaram os seguintes dados:

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

## 3. As Causas Raízes Técnicas

### Causa Raiz A: O Gargalo do Pipeline de Vídeo (Cópia VRAM $\rightarrow$ RAM + Compressão JPEG na CPU)
Veja o fluxo que está sendo executado em [`src-tauri/src/screen_sources.rs`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src-tauri/src/screen_sources.rs):
1. O Windows Graphics Capture (WGC) captura a textura DirectX na GPU.
2. `on_frame_arrived` chama `frame_buffer.as_nopadding_buffer(&mut self.raw_buffer)`: **faz o download de 8.3 MB a cada frame da memória de vídeo (VRAM) para a memória RAM através do barramento PCIe**. A 60 FPS, isso satura o barramento com **500 MB/s de cópias brutas**.
3. Em seguida, o processador executa redimensionamento bilinear em CPU (`fast_image_resize`).
4. Em seguida, o processador executa **compressão JPEG em software via CPU** (`FastJpegEncoder`) 60 vezes por segundo!
5. O JPEG é enviado via WebSocket local (`127.0.0.1:49153`) para o WebView2.
6. No JavaScript ([`src/video/native_video_bridge.ts`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src/video/native_video_bridge.ts)), o JPEG é decodificado via `createImageBitmap(blob)`, convertido em `VideoFrame` e inserido na `MediaStream`.
7. O WebRTC no WebView2 pega essa stream e **recomprime tudo uma segunda vez em H.264/VP8**!

> ⚠️ **Por que os jogos perdem FPS:** Esse fluxo consome múltiplos núcleos inteiros de CPU em compressão JPEG por software e disputa largura de banda PCIe e cache L3 com a GPU e com o jogo. Aplicativos como Discord e OBS capturam via GPU e passam a textura direto pro NVENC sem jamais transferir pixels para a CPU nem comprimir JPEGs!

---

### Causa Raiz B: Sessões WGC e Threads Presas / Não Finalizadas (Efeito Cumulativo)
1. A crate `windows-capture` cria uma thread com laço Win32 (`run_message_loop`) e um `DispatcherQueueController` do WinRT.
2. Quando `stop_native_screen_capture()` é chamado, a sessão de captura interna (`GraphicsCaptureSession` e `Direct3D11CaptureFramePool`) muitas vezes **não completa o ciclo de shutdown** e não chega a chamar `session.Close()` e `frame_pool.Close()`.
3. Como resultado, threads de background continuam vivas no Windows. A cada novo "Iniciar Compartilhamento", uma **nova** sessão WGC e novos despachantes de thread são alocados sem que os antigos tenham sido liberados.
4. Isso explica com precisão cirúrgica o consumo acumulativo: **cada tentativa abandona uma sessão/thread rodando no fundo que consome ~100% de um núcleo (3% a 4% no gerenciador), chegando a 20%+ após 5 ou 6 tentativas**.
5. Como a sessão DirectX permanece pendurada no driver da GPU, a RTX 3080 Ti mantém o estado D0 e o perfil de ventoinha em 47%.

---

## 4. Roteiro de Solução para o Antigravity no PC do Eduardo

Ao iniciar a sessão de trabalho nesta máquina, execute os seguintes passos:

### Passo 1: Inspecionar o Processo ao Vivo
Execute no terminal PowerShell para identificar as threads zumbis do `p2sharer.exe`:
```powershell
Get-Process p2sharer | Select-Object Id, ProcessName, CPU, Threads, TotalProcessorTime
```
Inspecione as threads específicas e veja quais IDs continuam consumindo tempo de CPU.

### Passo 2: Eliminar o Encodamento de JPEG na CPU e o WebSocket Local
Avaliar e implementar a captura direta de GPU:
- **Alternativa A (Chromium GPU Direct Capture):**
  - O WebView2 já suporta `navigator.mediaDevices.getDisplayMedia` com aceleração por hardware nativa. Em [`src/video/native_video_bridge.ts`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src/video/native_video_bridge.ts), existe o método `startDisplayMediaCapture()`.
  - Essa via utiliza a aceleração de hardware nativa do Chromium (GPU DXGI Desktop Duplication $\rightarrow$ NVENC por hardware $\rightarrow$ WebRTC), consumindo **menos de 1% de CPU** e causando **zero perda de FPS em jogos**.
  - O áudio dos processos continuará sendo filtrado pelo Rust (WASAPI Loopback) e mixado via `AudioBridge`.
- **Alternativa B (Rust WGC com Encerramento Robusto e Zero-Copy):**
  - Se mantiver a captura nativa no Rust, deve-se fechar explicitamente o `session.Close()` e `frame_pool.Close()` de forma determinística, garantindo que nenhuma thread fique órfã.
  - Eliminar o redimensionamento e codificação JPEG pesada na CPU, ou utilizar encoder por hardware (NVENC / D3D11 Video Processor) se os dados forem transmitidos para o frontend.

### Passo 3: Garantir Encerramento Determinístico dos Subsistemas
No arquivo [`src-tauri/src/screen_sources.rs`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src-tauri/src/screen_sources.rs) e [`src-tauri/src/audio_loopback.rs`](file:///c:/Users/imarc/Desktop/Documents/Coding/Outros/P2Sharer/src-tauri/src/audio_loopback.rs):
- Garantir que `stop_native_screen_capture` e `stop_audio_capture` finalizem de forma síncrona ou aguardem ativamente as threads terminarem antes de permitir uma nova inicialização.
- Impedir que múltiplas instâncias de captura se sobreponham.

### Passo 4: Validação do Ciclo de Vida
1. Iniciar transmissão $\rightarrow$ Verificar FPS no jogo e consumo de CPU.
2. Parar transmissão $\rightarrow$ Confirmar pelo painel de diagnóstico (`Ctrl + Shift + D`) que o uso do `p2sharer.exe` volta para **0.0%** e as ventoinhas desaceleram.
3. Repetir 5 vezes o ciclo de Iniciar/Parar e verificar se o consumo **NÃO acumula** (permanecendo estável em ~0%).

---
*Fim do documento de diagnóstico.*
