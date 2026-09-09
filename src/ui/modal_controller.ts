import { invoke } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store';
import { MonitorSource, ProcessItem, ScreenSourcesResponse, WindowSource } from '../core/types';
import { generateRandomRoomSlug } from '../p2p/group_room';
import { soundEffects } from './sound_effects';

export const ICONS = {
  lock: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  unlock: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
  eye: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
};

export interface ModalControllerCallbacks {
  onJoinRoom: (code: string, pass: string, isCreator: boolean) => void;
  onUpdateRoomPassword: (pass: string) => void;
  onStartCapture: (sourceId: string, fps: number, res: { width: number; height: number }, mouse: boolean) => Promise<void>;
}

export class ModalController {
  private callbacks: ModalControllerCallbacks;

  // Screen picker state
  private availableMonitors: MonitorSource[] = [];
  private availableWindows: WindowSource[] = [];
  private currentPickerTab: 'screens' | 'windows' = 'screens';
  private selectedSourceId: string = 'screen:0';

  // Audio filter state
  private audioProcesses: ProcessItem[] = [];

  constructor(callbacks: ModalControllerCallbacks) {
    this.callbacks = callbacks;
  }

  public showToast(message: string, durationMs = 3500): void {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, durationMs);
  }

  // --- Theme & Accent ---
  public applyTheme(mode: 'dark' | 'light' | 'system'): void {
    stateStore.currentThemeMode = mode;
    let effectiveTheme = mode;
    if (mode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      effectiveTheme = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    localStorage.setItem('p2sharer_theme_mode', mode);

    document.querySelectorAll('.theme-mode-pills .pill-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-theme-mode') === mode);
    });
  }

  public applyAccent(accent: string): void {
    stateStore.currentAccentColor = accent;
    document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('p2sharer_accent_color', accent);

    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
      swatch.classList.toggle('active', swatch.getAttribute('data-accent') === accent);
    });
  }

  // --- Username Modal ---
  public showUsernameModal(): void {
    const modal = document.getElementById('modal-username');
    const input = document.getElementById('input-username') as HTMLInputElement;
    if (modal && input) {
      input.value = stateStore.username || `User_${Math.floor(1000 + Math.random() * 9000)}`;
      modal.classList.remove('hidden');
      input.focus();
    }
  }

  public updateUsernameDisplay(): void {
    const displayEl = document.getElementById('current-username-display');
    if (displayEl) displayEl.textContent = stateStore.username || 'Usuário';
  }

  // --- Settings Modal ---
  public openSettingsModal(): void {
    const modal = document.getElementById('modal-settings');
    const inputUsername = document.getElementById('settings-input-username') as HTMLInputElement;
    const selectRes = document.getElementById('settings-default-resolution') as HTMLSelectElement;
    const selectFps = document.getElementById('settings-default-fps') as HTMLSelectElement;
    const selectBitrate = document.getElementById('settings-default-bitrate') as HTMLSelectElement;
    const checkCursor = document.getElementById('settings-check-cursor') as HTMLInputElement;

    const checkTurn = document.getElementById('settings-enable-turn') as HTMLInputElement;
    const inputTurnUrl = document.getElementById('settings-turn-url') as HTMLInputElement;
    const inputTurnUser = document.getElementById('settings-turn-username') as HTMLInputElement;
    const inputTurnCred = document.getElementById('settings-turn-credential') as HTMLInputElement;
    const checkTurnRelay = document.getElementById('settings-turn-force-relay') as HTMLInputElement;
    const turnFields = document.getElementById('turn-config-fields');

    if (inputUsername) inputUsername.value = stateStore.username;
    if (selectRes) selectRes.value = localStorage.getItem('p2sharer_default_res') || '1080p';
    if (selectFps) selectFps.value = localStorage.getItem('p2sharer_default_fps') || '60';
    if (selectBitrate) selectBitrate.value = localStorage.getItem('p2sharer_default_bitrate') || '25000';
    if (checkCursor) checkCursor.checked = localStorage.getItem('p2sharer_default_cursor') !== 'false';

    const turnEnabled = localStorage.getItem('p2sharer_turn_enabled') === 'true';
    if (checkTurn) checkTurn.checked = turnEnabled;
    if (inputTurnUrl) inputTurnUrl.value = localStorage.getItem('p2sharer_turn_url') || '';
    if (inputTurnUser) inputTurnUser.value = localStorage.getItem('p2sharer_turn_user') || '';
    if (inputTurnCred) inputTurnCred.value = localStorage.getItem('p2sharer_turn_cred') || '';
    if (checkTurnRelay) checkTurnRelay.checked = localStorage.getItem('p2sharer_turn_force_relay') === 'true';
    if (turnFields) turnFields.style.display = turnEnabled ? 'flex' : 'none';

    const checkSfx = document.getElementById('settings-check-sfx-enabled') as HTMLInputElement;
    const sliderSfx = document.getElementById('settings-slider-sfx-volume') as HTMLInputElement;
    const labelSfx = document.getElementById('settings-sfx-volume-label');
    if (checkSfx) checkSfx.checked = soundEffects.getEnabled();
    const currentVolPercent = Math.round(soundEffects.getVolume() * 100);
    if (sliderSfx) sliderSfx.value = currentVolPercent.toString();
    if (labelSfx) labelSfx.textContent = `${currentVolPercent}%`;

    invoke<string>('get_log_file_path')
      .then((path) => {
        const pathEl = document.getElementById('settings-log-path-text');
        if (pathEl) pathEl.textContent = path;
      })
      .catch(() => {});

    modal?.classList.remove('hidden');
  }

  public closeSettingsModal(): void {
    document.getElementById('modal-settings')?.classList.add('hidden');
  }

  public saveSettingsFromModal(): void {
    const inputUsername = document.getElementById('settings-input-username') as HTMLInputElement;
    const selectRes = document.getElementById('settings-default-resolution') as HTMLSelectElement;
    const selectFps = document.getElementById('settings-default-fps') as HTMLSelectElement;
    const selectBitrate = document.getElementById('settings-default-bitrate') as HTMLSelectElement;
    const checkCursor = document.getElementById('settings-check-cursor') as HTMLInputElement;

    const checkTurn = document.getElementById('settings-enable-turn') as HTMLInputElement;
    const inputTurnUrl = document.getElementById('settings-turn-url') as HTMLInputElement;
    const inputTurnUser = document.getElementById('settings-turn-username') as HTMLInputElement;
    const inputTurnCred = document.getElementById('settings-turn-credential') as HTMLInputElement;
    const checkTurnRelay = document.getElementById('settings-turn-force-relay') as HTMLInputElement;

    const checkSfx = document.getElementById('settings-check-sfx-enabled') as HTMLInputElement;
    const sliderSfx = document.getElementById('settings-slider-sfx-volume') as HTMLInputElement;

    if (checkSfx) soundEffects.setEnabled(checkSfx.checked);
    if (sliderSfx) soundEffects.setVolume(parseInt(sliderSfx.value, 10) / 100);

    if (inputUsername && inputUsername.value.trim()) {
      stateStore.username = inputUsername.value.trim();
      localStorage.setItem('p2sharer_username', stateStore.username);
      this.updateUsernameDisplay();
    }

    if (selectRes) localStorage.setItem('p2sharer_default_res', selectRes.value);
    if (selectFps) localStorage.setItem('p2sharer_default_fps', selectFps.value);
    if (selectBitrate) localStorage.setItem('p2sharer_default_bitrate', selectBitrate.value);
    if (checkCursor) localStorage.setItem('p2sharer_default_cursor', checkCursor.checked.toString());

    const isTurnChecked = checkTurn?.checked === true;
    localStorage.setItem('p2sharer_turn_enabled', isTurnChecked ? 'true' : 'false');

    if (inputTurnUrl) {
      let turnUrlVal = inputTurnUrl.value.trim();
      if (turnUrlVal && !turnUrlVal.startsWith('turn:') && !turnUrlVal.startsWith('turns:') && !turnUrlVal.startsWith('stun:')) {
        turnUrlVal = `turn:${turnUrlVal}`;
        inputTurnUrl.value = turnUrlVal;
      }
      localStorage.setItem('p2sharer_turn_url', turnUrlVal);
    }
    if (inputTurnUser) localStorage.setItem('p2sharer_turn_user', inputTurnUser.value.trim());
    if (inputTurnCred) localStorage.setItem('p2sharer_turn_cred', inputTurnCred.value.trim());
    if (checkTurnRelay) localStorage.setItem('p2sharer_turn_force_relay', checkTurnRelay.checked ? 'true' : 'false');

    this.syncPickerModalDefaults();
    this.closeSettingsModal();
    this.showToast('Configurações salvas com sucesso!');
  }

  public syncPickerModalDefaults(): void {
    const savedRes = localStorage.getItem('p2sharer_default_res') || '1080p';
    const savedFps = parseInt(localStorage.getItem('p2sharer_default_fps') || '60', 10);
    const savedBitrate = parseInt(localStorage.getItem('p2sharer_default_bitrate') || '25000', 10);
    const savedCursor = localStorage.getItem('p2sharer_default_cursor') !== 'false';

    stateStore.currentFps = savedFps;
    stateStore.currentBitrate = savedBitrate;
    stateStore.currentResolution = stateStore.parseResolution(savedRes);

    const modalRes = document.getElementById('modal-select-resolution') as HTMLSelectElement;
    const modalFps = document.getElementById('modal-select-fps') as HTMLSelectElement;
    const modalBitrate = document.getElementById('modal-select-bitrate') as HTMLSelectElement;
    const modalCursor = document.getElementById('modal-check-cursor') as HTMLInputElement;

    if (modalRes) modalRes.value = savedRes;
    if (modalFps) modalFps.value = savedFps.toString();
    if (modalBitrate) modalBitrate.value = savedBitrate.toString();
    if (modalCursor) modalCursor.checked = savedCursor;
  }

  // --- Create Room Dialog ---
  public openCreateRoomDialog(): void {
    if (!stateStore.username) {
      this.showUsernameModal();
      return;
    }
    const modal = document.getElementById('modal-create-room-dialog');
    const codeInput = document.getElementById('input-create-room-code-dialog') as HTMLInputElement;
    const passInput = document.getElementById('input-create-room-password-dialog') as HTMLInputElement;

    if (codeInput) codeInput.value = generateRandomRoomSlug();
    if (passInput) passInput.value = '';

    modal?.classList.remove('hidden');
    codeInput?.focus();
  }

  public closeCreateRoomDialog(): void {
    document.getElementById('modal-create-room-dialog')?.classList.add('hidden');
  }

  public regenCreateRoomCode(): void {
    const codeInput = document.getElementById('input-create-room-code-dialog') as HTMLInputElement;
    if (codeInput) codeInput.value = generateRandomRoomSlug();
  }

  public confirmCreateRoomFromDialog(): void {
    const codeInput = (document.getElementById('input-create-room-code-dialog') as HTMLInputElement).value.trim();
    const passInput = (document.getElementById('input-create-room-password-dialog') as HTMLInputElement).value.trim();

    const code = codeInput || generateRandomRoomSlug();
    this.closeCreateRoomDialog();
    this.callbacks.onJoinRoom(code, passInput, true);

    if (passInput) {
      this.showToast(`Sala "${code}" criada com proteção por senha!`);
    } else {
      this.showToast(`Sala "${code}" criada!`);
    }
  }

  // --- Join Room Dialog ---
  public openJoinDialog(): void {
    if (!stateStore.username) {
      this.showUsernameModal();
      return;
    }
    const modal = document.getElementById('modal-join-room-dialog');
    const codeInput = document.getElementById('input-join-room-code-dialog') as HTMLInputElement;
    const passInput = document.getElementById('input-join-room-password-dialog') as HTMLInputElement;

    if (codeInput) codeInput.value = '';
    if (passInput) passInput.value = '';

    modal?.classList.remove('hidden');
    codeInput?.focus();
  }

  public closeJoinDialog(): void {
    document.getElementById('modal-join-room-dialog')?.classList.add('hidden');
  }

  public confirmJoinFromDialog(): void {
    const codeInput = (document.getElementById('input-join-room-code-dialog') as HTMLInputElement).value.trim();
    const passInput = (document.getElementById('input-join-room-password-dialog') as HTMLInputElement).value.trim();

    if (!codeInput) {
      this.showToast('Por favor, digite o código da sala.');
      return;
    }

    this.closeJoinDialog();
    this.callbacks.onJoinRoom(codeInput, passInput, false);
    this.showToast(`Conectando à sala ${codeInput}...`);
  }

  // --- Connecting Overlay ---
  public showConnectingOverlay(roomCode: string, title = 'Entrando na sala...', subtitle = 'Estabelecendo sinalização e túnel P2P criptografado...'): void {
    const overlay = document.getElementById('connecting-overlay');
    const titleEl = document.getElementById('connecting-title');
    const subEl = document.getElementById('connecting-subtitle');
    const codeEl = document.getElementById('connecting-room-code');

    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
    if (codeEl) codeEl.textContent = `SALA: ${roomCode}${stateStore.currentRoomPassword ? ' (Protegida)' : ''}`;
    if (overlay) overlay.classList.remove('hidden');
  }

  public hideConnectingOverlay(): void {
    const overlay = document.getElementById('connecting-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  // --- Password Visibility Toggle ---
  public togglePasswordVisibility(inputId: string, iconId: string): void {
    const input = document.getElementById(inputId) as HTMLInputElement;
    const icon = document.getElementById(iconId);
    if (!input) return;

    if (input.type === 'password') {
      input.type = 'text';
      if (icon) icon.innerHTML = ICONS.eyeOff;
    } else {
      input.type = 'password';
      if (icon) icon.innerHTML = ICONS.eye;
    }
  }

  // --- Screen Picker Modal ---
  public async openScreenPickerModal(): Promise<void> {
    const modal = document.getElementById('modal-screen-picker');
    if (!modal) return;
    modal.classList.remove('hidden');

    this.syncPickerModalDefaults();
    this.currentPickerTab = 'screens';
    this.selectedSourceId = 'screen:0';
    this.updatePickerTabUI();

    await this.loadScreenSources();
  }

  public closeScreenPickerModal(): void {
    document.getElementById('modal-screen-picker')?.classList.add('hidden');
  }

  public switchPickerTab(tab: 'screens' | 'windows'): void {
    this.currentPickerTab = tab;
    this.updatePickerTabUI();
    this.renderSourceCards();
  }

  private updatePickerTabUI(): void {
    document.getElementById('picker-tab-screens')?.classList.toggle('active', this.currentPickerTab === 'screens');
    document.getElementById('picker-tab-windows')?.classList.toggle('active', this.currentPickerTab === 'windows');
  }

  private async loadScreenSources(): Promise<void> {
    const container = document.getElementById('picker-sources-container');
    if (container) container.innerHTML = '<div class="loading-state">Detectando telas e janelas ativas...</div>';

    try {
      const resp = await invoke<ScreenSourcesResponse>('list_screen_sources');
      this.availableMonitors = resp.monitors || [];
      this.availableWindows = resp.windows || [];

      if (this.availableMonitors.length > 0) {
        this.selectedSourceId = this.availableMonitors[0].id;
      } else if (this.availableWindows.length > 0) {
        this.selectedSourceId = this.availableWindows[0].id;
      }

      this.renderSourceCards();
    } catch (err) {
      console.error('Failed to list screen sources:', err);
      if (container) container.innerHTML = '<div class="loading-state">Erro ao detectar telas.</div>';
    }
  }

  private renderSourceCards(): void {
    const container = document.getElementById('picker-sources-container');
    if (!container) return;
    container.innerHTML = '';

    if (this.currentPickerTab === 'screens') {
      if (this.availableMonitors.length === 0) {
        container.innerHTML = '<div class="loading-state">Nenhum monitor detectado.</div>';
        return;
      }

      this.availableMonitors.forEach((mon) => {
        const isSelected = this.selectedSourceId === mon.id;
        const card = document.createElement('div');
        card.className = `source-card ${isSelected ? 'selected' : ''}`;
        card.innerHTML = `
          <div class="source-card-thumb">
            ${mon.thumbnail ? `<img src="${mon.thumbnail}" alt="${mon.name}" />` : '<div class="source-card-thumb-placeholder">Monitor</div>'}
          </div>
          <div class="source-card-info">
            <div class="source-card-title">${mon.name}</div>
            <div class="source-card-subtitle">${mon.width}x${mon.height}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          this.selectedSourceId = mon.id;
          this.renderSourceCards();
        });
        container.appendChild(card);
      });
    } else {
      if (this.availableWindows.length === 0) {
        container.innerHTML = '<div class="loading-state">Nenhuma janela aberta encontrada.</div>';
        return;
      }

      this.availableWindows.forEach((win) => {
        const isSelected = this.selectedSourceId === win.id;
        const card = document.createElement('div');
        card.className = `source-card ${isSelected ? 'selected' : ''}`;
        card.innerHTML = `
          <div class="source-card-thumb">
            ${win.thumbnail ? `<img src="${win.thumbnail}" alt="${win.title}" />` : '<div class="source-card-thumb-placeholder">Janela</div>'}
          </div>
          <div class="source-card-info">
            <div class="source-card-title">${win.title || win.process_name}</div>
            <div class="source-card-subtitle">${win.process_name}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          this.selectedSourceId = win.id;
          this.renderSourceCards();
        });
        container.appendChild(card);
      });
    }
  }

  public async confirmScreenPicker(): Promise<void> {
    this.closeScreenPickerModal();

    const resValue = (document.getElementById('modal-select-resolution') as HTMLSelectElement)?.value || '1080p';
    const fpsValue = parseInt((document.getElementById('modal-select-fps') as HTMLSelectElement)?.value, 10) || 60;
    const bitrateValue = parseInt((document.getElementById('modal-select-bitrate') as HTMLSelectElement)?.value, 10) || 25000;
    const mouseEnabled = (document.getElementById('modal-check-cursor') as HTMLInputElement)?.checked ?? true;

    stateStore.currentResolution = stateStore.parseResolution(resValue);
    stateStore.currentFps = fpsValue;
    stateStore.currentBitrate = bitrateValue;

    await this.callbacks.onStartCapture(
      this.selectedSourceId,
      fpsValue,
      { width: stateStore.currentResolution.width, height: stateStore.currentResolution.height },
      mouseEnabled
    );
  }

  public async startDirectGpuCapture(): Promise<void> {
    this.closeScreenPickerModal();

    const resValue = (document.getElementById('modal-select-resolution') as HTMLSelectElement)?.value || '1080p';
    const fpsValue = parseInt((document.getElementById('modal-select-fps') as HTMLSelectElement)?.value, 10) || 60;
    const bitrateValue = parseInt((document.getElementById('modal-select-bitrate') as HTMLSelectElement)?.value, 10) || 25000;
    const mouseEnabled = (document.getElementById('modal-check-cursor') as HTMLInputElement)?.checked ?? true;

    stateStore.currentResolution = stateStore.parseResolution(resValue);
    stateStore.currentFps = fpsValue;
    stateStore.currentBitrate = bitrateValue;

    await this.callbacks.onStartCapture(
      'gpu_direct',
      fpsValue,
      { width: stateStore.currentResolution.width, height: stateStore.currentResolution.height },
      mouseEnabled
    );
  }

  // --- Audio Filter Modal ---
  public openAudioFilterModal(): void {
    const modal = document.getElementById('modal-audio-filter');
    if (!modal) return;
    modal.classList.remove('hidden');

    const radio = document.querySelector(`input[name="audio-filter-mode"][value="${stateStore.selectedFilterMode}"]`) as HTMLInputElement;
    if (radio) radio.checked = true;

    this.loadProcessList();
  }

  public closeAudioFilterModal(): void {
    document.getElementById('modal-audio-filter')?.classList.add('hidden');
  }

  public async loadProcessList(): Promise<void> {
    const container = document.getElementById('process-checkboxes-container');
    if (container) container.innerHTML = '<div class="loading-state">Atualizando lista de aplicativos...</div>';

    try {
      this.audioProcesses = await invoke<ProcessItem[]>('list_audio_processes');

      stateStore.excludePids.clear();
      stateStore.includePids.clear();

      this.audioProcesses.forEach((p) => {
        const nameLower = p.name.toLowerCase();
        if (stateStore.excludeProcessNames.has(nameLower)) {
          stateStore.excludePids.add(p.pid);
        }
        if (stateStore.includeProcessNames.has(nameLower)) {
          stateStore.includePids.add(p.pid);
        }
      });

      const searchInput = document.getElementById('input-search-process') as HTMLInputElement;
      const search = searchInput ? searchInput.value.toLowerCase() : '';
      this.renderProcessCheckboxes(search);
    } catch (err) {
      console.error('Failed to list processes:', err);
      if (container) container.innerHTML = '<div class="loading-state">Erro ao carregar aplicativos.</div>';
    }
  }

  public renderProcessCheckboxes(filterText = ''): void {
    const container = document.getElementById('process-checkboxes-container');
    if (!container) return;

    const isExclude = stateStore.selectedFilterMode === 'exclude';
    const activePids = isExclude ? stateStore.excludePids : stateStore.includePids;
    const activeNames = isExclude ? stateStore.excludeProcessNames : stateStore.includeProcessNames;

    const filtered = this.audioProcesses.filter(
      (p) =>
        p.name.toLowerCase().includes(filterText) ||
        (p.window_title && p.window_title.toLowerCase().includes(filterText)) ||
        p.pid.toString().includes(filterText)
    );

    if (filtered.length === 0) {
      container.innerHTML = '<div class="loading-state">Nenhum aplicativo correspondente.</div>';
      return;
    }

    container.innerHTML = '';
    filtered.forEach((p) => {
      const nameLower = p.name.toLowerCase();
      const label = document.createElement('label');
      label.className = 'process-item-label';
      const isChecked = activePids.has(p.pid) || activeNames.has(nameLower);

      label.innerHTML = `
        <input type="checkbox" value="${p.pid}" ${isChecked ? 'checked' : ''} />
        <span class="process-name">${p.name}</span>
        ${p.window_title ? `<span class="process-title">(${p.window_title})</span>` : ''}
        <span class="process-pid">PID: ${p.pid}</span>
      `;

      const checkbox = label.querySelector('input');
      checkbox?.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.checked) {
          activeNames.add(nameLower);
          this.audioProcesses.forEach((other) => {
            if (other.name.toLowerCase() === nameLower) {
              activePids.add(other.pid);
            }
          });
        } else {
          activeNames.delete(nameLower);
          this.audioProcesses.forEach((other) => {
            if (other.name.toLowerCase() === nameLower) {
              activePids.delete(other.pid);
            }
          });
        }
        stateStore.saveAudioFilterPresets();
      });

      container.appendChild(label);
    });
  }

  public async applyAudioFilters(): Promise<void> {
    const pidsArray = stateStore.getActiveFilterPids();
    const namesArray = stateStore.getActiveFilterNames();
    stateStore.saveAudioFilterPresets();

    try {
      await invoke('start_audio_capture', {
        config: {
          mode: stateStore.selectedFilterMode,
          target_pids: pidsArray,
          target_names: namesArray,
          sample_rate: 48000,
        },
      });
      this.closeAudioFilterModal();
      const count = namesArray.length || pidsArray.length;
      const msg =
        stateStore.selectedFilterMode === 'exclude'
          ? `Filtro aplicado: Silenciando ${count} aplicativo(s)`
          : `Filtro aplicado: Transmitindo apenas ${count} aplicativo(s)`;
      this.showToast(msg);
    } catch (err) {
      console.error('Error applying audio filter:', err);
      this.showToast('Erro ao aplicar filtros de áudio.');
    }
  }

  // --- Room Security Modal ---
  public openRoomSecurityModal(): void {
    const modal = document.getElementById('modal-room-security');
    const codeEl = document.getElementById('sec-modal-room-code');
    const statusEl = document.getElementById('sec-modal-current-status');
    const passInput = document.getElementById('input-room-security-password') as HTMLInputElement;

    if (codeEl) codeEl.textContent = stateStore.currentRoomCode;
    if (statusEl) {
      statusEl.innerHTML = stateStore.currentRoomPassword
        ? `${ICONS.lock} <span>Protegida por Senha ("${stateStore.currentRoomPassword}")</span>`
        : `${ICONS.unlock} <span>Pública (Sem Senha)</span>`;
    }
    if (passInput) passInput.value = stateStore.currentRoomPassword;

    modal?.classList.remove('hidden');
    passInput?.focus();
  }

  public closeRoomSecurityModal(): void {
    document.getElementById('modal-room-security')?.classList.add('hidden');
  }

  public saveRoomSecurityPassword(): void {
    const passInput = (document.getElementById('input-room-security-password') as HTMLInputElement).value.trim();
    const oldPassword = stateStore.currentRoomPassword;
    stateStore.currentRoomPassword = passInput;

    this.callbacks.onUpdateRoomPassword(passInput);
    this.updateRoomSecurityHeaderUI();
    this.closeRoomSecurityModal();

    if (passInput) {
      this.showToast(`Senha da sala alterada para "${passInput}" e sincronizada com todos!`, 4000);
    } else if (oldPassword && !passInput) {
      this.showToast('Senha removida: a sala agora é pública.', 4000);
    } else {
      this.showToast('Configurações de segurança da sala salvas.');
    }
  }

  public updateRoomSecurityHeaderUI(): void {
    const codeEl = document.getElementById('display-room-code');
    const lockEl = document.getElementById('header-room-lock-icon');
    const pillEl = document.getElementById('header-room-code-pill');

    if (codeEl) codeEl.textContent = stateStore.currentRoomCode;
    if (lockEl) {
      lockEl.innerHTML = stateStore.currentRoomPassword ? ICONS.lock : ICONS.unlock;
      lockEl.title = stateStore.currentRoomPassword
        ? `Protegida por Senha: ${stateStore.currentRoomPassword}`
        : 'Sala Pública (Sem Senha)';
    }
    if (pillEl) {
      pillEl.title = stateStore.currentRoomPassword
        ? `Clique para copiar o código e senha da sala (${stateStore.currentRoomCode})`
        : `Clique para copiar o código da sala (${stateStore.currentRoomCode})`;
    }
  }

  public bindModalEvents(): void {
    document.getElementById('btn-open-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-close-settings')?.addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('btn-cancel-settings')?.addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('btn-save-settings')?.addEventListener('click', () => this.saveSettingsFromModal());
    document.getElementById('user-pill')?.addEventListener('click', () => this.openSettingsModal());

    document.querySelectorAll('.settings-nav-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const targetTab = (e.currentTarget as HTMLElement).getAttribute('data-settings-tab');
        if (!targetTab) return;
        document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.settings-tab-pane').forEach((p) => p.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        document.getElementById(`settings-pane-${targetTab}`)?.classList.add('active');
      });
    });

    document.getElementById('btn-open-latest-log')?.addEventListener('click', async () => {
      try { await invoke('open_latest_log'); } catch (err) { this.showToast(`Erro: ${err}`); }
    });
    document.getElementById('btn-open-log-folder')?.addEventListener('click', async () => {
      try { await invoke('open_log_folder'); } catch (err) { this.showToast(`Erro: ${err}`); }
    });
    document.getElementById('btn-clear-log-file')?.addEventListener('click', async () => {
      try { await invoke('clear_log_file'); this.showToast('Log limpo com sucesso!'); } catch (err) { this.showToast(`Erro: ${err}`); }
    });

    document.querySelectorAll('.theme-mode-pills .pill-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mode = (e.currentTarget as HTMLElement).getAttribute('data-theme-mode') as 'dark' | 'light' | 'system';
        if (mode) this.applyTheme(mode);
      });
    });
    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
      swatch.addEventListener('click', (e) => {
        const accent = (e.currentTarget as HTMLElement).getAttribute('data-accent');
        if (accent) this.applyAccent(accent);
      });
    });

    const checkSfx = document.getElementById('settings-check-sfx-enabled') as HTMLInputElement;
    const sliderSfx = document.getElementById('settings-slider-sfx-volume') as HTMLInputElement;
    const labelSfx = document.getElementById('settings-sfx-volume-label');
    checkSfx?.addEventListener('change', () => soundEffects.setEnabled(checkSfx.checked));
    sliderSfx?.addEventListener('input', () => {
      const vol = parseInt(sliderSfx.value, 10);
      soundEffects.setVolume(vol / 100);
      if (labelSfx) labelSfx.textContent = `${vol}%`;
    });

    document.getElementById('btn-test-sfx-join')?.addEventListener('click', () => soundEffects.playUserJoin());
    document.getElementById('btn-test-sfx-stream-start')?.addEventListener('click', () => soundEffects.playScreenShareStart());
    document.getElementById('btn-test-sfx-watch-start')?.addEventListener('click', () => soundEffects.playWatchStreamStart());
    document.getElementById('btn-test-sfx-watch-stop')?.addEventListener('click', () => soundEffects.playWatchStreamStop());

    document.getElementById('settings-enable-turn')?.addEventListener('change', (e) => {
      const isChecked = (e.target as HTMLInputElement).checked;
      const fields = document.getElementById('turn-config-fields');
      if (fields) fields.style.display = isChecked ? 'flex' : 'none';
    });

    document.getElementById('btn-save-username')?.addEventListener('click', () => {
      const input = document.getElementById('input-username') as HTMLInputElement;
      const val = input?.value.trim();
      if (!val) {
        this.showToast('Por favor, digite um nome válido.');
        return;
      }
      stateStore.username = val;
      localStorage.setItem('p2sharer_username', val);
      this.updateUsernameDisplay();
      document.getElementById('modal-username')?.classList.add('hidden');
      this.showToast(`Nome salvo: ${val}`);
    });

    document.getElementById('btn-create-room-direct')?.addEventListener('click', () => this.openCreateRoomDialog());
    document.getElementById('btn-close-create-dialog')?.addEventListener('click', () => this.closeCreateRoomDialog());
    document.getElementById('btn-cancel-create-dialog')?.addEventListener('click', () => this.closeCreateRoomDialog());
    document.getElementById('btn-regen-room-code')?.addEventListener('click', () => this.regenCreateRoomCode());
    document.getElementById('btn-confirm-create-dialog')?.addEventListener('click', () => this.confirmCreateRoomFromDialog());

    document.getElementById('btn-start-join-flow')?.addEventListener('click', () => this.openJoinDialog());
    document.getElementById('btn-close-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-cancel-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-confirm-join-dialog')?.addEventListener('click', () => this.confirmJoinFromDialog());

    document.getElementById('btn-open-room-security')?.addEventListener('click', () => this.openRoomSecurityModal());
    document.getElementById('btn-close-room-security')?.addEventListener('click', () => this.closeRoomSecurityModal());
    document.getElementById('btn-cancel-room-security')?.addEventListener('click', () => this.closeRoomSecurityModal());
    document.getElementById('btn-save-room-security')?.addEventListener('click', () => this.saveRoomSecurityPassword());

    document.getElementById('btn-toggle-create-password-visibility')?.addEventListener('click', () => {
      this.togglePasswordVisibility('input-create-room-password-dialog', 'icon-create-pass-toggle');
    });
    document.getElementById('btn-toggle-join-password-visibility')?.addEventListener('click', () => {
      this.togglePasswordVisibility('input-join-room-password-dialog', 'icon-join-pass-toggle');
    });
    document.getElementById('btn-toggle-security-password-visibility')?.addEventListener('click', () => {
      this.togglePasswordVisibility('input-room-security-password', 'icon-sec-pass-toggle');
    });

    document.getElementById('btn-close-screen-picker')?.addEventListener('click', () => this.closeScreenPickerModal());
    document.getElementById('btn-cancel-picker')?.addEventListener('click', () => this.closeScreenPickerModal());
    document.getElementById('btn-confirm-picker')?.addEventListener('click', () => this.confirmScreenPicker());
    document.getElementById('picker-tab-screens')?.addEventListener('click', () => this.switchPickerTab('screens'));
    document.getElementById('picker-tab-windows')?.addEventListener('click', () => this.switchPickerTab('windows'));

    document.getElementById('btn-start-direct-gpu')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startDirectGpuCapture();
    });
    document.getElementById('card-direct-gpu-capture')?.addEventListener('click', () => {
      this.startDirectGpuCapture();
    });
    document.getElementById('card-direct-gpu-capture')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
        e.preventDefault();
        this.startDirectGpuCapture();
      }
    });

    document.getElementById('btn-open-audio-filter')?.addEventListener('click', () => this.openAudioFilterModal());
    document.getElementById('btn-close-audio-modal')?.addEventListener('click', () => this.closeAudioFilterModal());
    document.getElementById('btn-cancel-audio-filter')?.addEventListener('click', () => this.closeAudioFilterModal());
    document.getElementById('btn-refresh-processes')?.addEventListener('click', () => this.loadProcessList());
    document.getElementById('btn-apply-audio-filter')?.addEventListener('click', () => this.applyAudioFilters());
    document.getElementById('input-search-process')?.addEventListener('input', (e) => {
      this.renderProcessCheckboxes((e.target as HTMLInputElement).value.toLowerCase());
    });

    document.querySelectorAll('input[name="audio-filter-mode"]').forEach((r) => {
      r.addEventListener('change', (e) => {
        stateStore.selectedFilterMode = (e.target as HTMLInputElement).value as 'exclude' | 'include';
        stateStore.saveAudioFilterPresets();
        const search = (document.getElementById('input-search-process') as HTMLInputElement)?.value.toLowerCase() || '';
        this.renderProcessCheckboxes(search);
      });
    });
  }
}
