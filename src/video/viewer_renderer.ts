import { audioContextManager } from '../audio/audio_context_manager.ts';
import { formatFrameRate } from '../core/media_streams.ts';
import { stateStore } from '../core/state_store.ts';
import type { RoomSlotInfo, StreamCardCacheItem } from '../core/types.ts';

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m] || m));
}

export interface ViewerRendererCallbacks {
  onRequestStream: (peerId: string) => void;
  onStopWatchingStream: (peerId: string) => void;
  getPeerPing: (peerId: string) => number | null | undefined;
}

export class ViewerRenderer {
  private cachedCards = new Map<string, StreamCardCacheItem>();
  private callbacks: ViewerRendererCallbacks;

  constructor(callbacks: ViewerRendererCallbacks) {
    this.callbacks = callbacks;
  }

  public renderRoomCards(): void {
    const gridWrapper = document.getElementById('streams-grid-wrapper');
    const spotlightStage = document.getElementById('spotlight-stage');
    const featuredArea = document.getElementById('spotlight-featured-area');
    const trayStrip = document.getElementById('spotlight-tray-strip');
    const sharingTag = document.getElementById('room-sharing-status-tag');
    const liveBadge = document.getElementById('room-live-badge');

    if (!gridWrapper || !spotlightStage || !featuredArea || !trayStrip) return;

    const totalCount = stateStore.roomSlots.length;
    const streamingCount = stateStore.roomSlots.filter((s) => s.isStreaming).length;

    if (sharingTag) {
      sharingTag.textContent = `${totalCount} ${totalCount === 1 ? 'pessoa' : 'pessoas'} (${streamingCount} ao vivo)`;
    }
    if (liveBadge) {
      liveBadge.textContent = streamingCount > 0 ? 'AO VIVO' : 'SALA ATIVA';
    }

    // Auto-revert spotlight if pinned peer is no longer in roomSlots
    if (stateStore.pinnedPeerId && !stateStore.roomSlots.some((s) => s.peerId === stateStore.pinnedPeerId)) {
      stateStore.pinnedPeerId = null;
      stateStore.layoutMode = 'grid';
    }

    // 1. Prune departed peers
    const currentPeerIds = new Set(stateStore.roomSlots.map((s) => s.peerId));
    this.cachedCards.forEach((cached, peerId) => {
      if (!currentPeerIds.has(peerId)) {
        this.cleanupPeerCard(peerId, cached);
        this.cachedCards.delete(peerId);
      }
    });

    // 2. Keyed non-destructive DOM reconciliation per layoutMode
    if (stateStore.layoutMode === 'grid') {
      gridWrapper.classList.remove('hidden');
      spotlightStage.classList.add('hidden');

      stateStore.roomSlots.forEach((slot, index) => {
        this.reconcileSlotCard(slot, false, gridWrapper, index);
      });

      // Prune excess children from gridWrapper
      while (gridWrapper.children.length > stateStore.roomSlots.length) {
        const excess = gridWrapper.children[gridWrapper.children.length - 1];
        if (excess) gridWrapper.removeChild(excess);
      }

      // Ensure inactive containers are clean
      this.pruneContainer(featuredArea);
      this.pruneContainer(trayStrip);
    } else {
      gridWrapper.classList.add('hidden');
      spotlightStage.classList.remove('hidden');

      const featuredSlot =
        stateStore.roomSlots.find((s) => s.peerId === stateStore.pinnedPeerId) || stateStore.roomSlots[0];

      if (featuredSlot) {
        this.reconcileSlotCard(featuredSlot, true, featuredArea, 0);
        while (featuredArea.children.length > 1) {
          const excess = featuredArea.children[featuredArea.children.length - 1];
          if (excess) featuredArea.removeChild(excess);
        }
      } else {
        this.pruneContainer(featuredArea);
      }

      const otherSlots = stateStore.roomSlots.filter((s) => s.peerId !== featuredSlot?.peerId);
      otherSlots.forEach((slot, index) => {
        this.reconcileSlotCard(slot, false, trayStrip, index);
      });

      while (trayStrip.children.length > otherSlots.length) {
        const excess = trayStrip.children[trayStrip.children.length - 1];
        if (excess) trayStrip.removeChild(excess);
      }

      // Ensure inactive container is clean
      this.pruneContainer(gridWrapper);
    }
  }

  private reconcileSlotCard(
    slot: RoomSlotInfo,
    isFeatured: boolean,
    targetContainer: HTMLElement,
    targetIndex: number
  ): HTMLElement {
    const isSubscribed = stateStore.subscribedStreams.has(slot.peerId);
    const shouldBeVideo =
      (slot.isLocal && slot.isStreaming && Boolean(slot.stream)) ||
      (!slot.isLocal && slot.isStreaming && isSubscribed && Boolean(slot.stream));

    const subMode: 'video' | 'connecting' | 'can_watch' | 'idle' = shouldBeVideo
      ? 'video'
      : slot.isStreaming && isSubscribed && !slot.stream
      ? 'connecting'
      : slot.isStreaming && !isSubscribed
      ? 'can_watch'
      : 'idle';

    const streamId = slot.stream?.id;
    let cached = this.cachedCards.get(slot.peerId);

    // If card type changed (e.g. avatar <-> video, or connecting <-> can_watch), dismantle old card
    if (cached && (cached.isVideo !== shouldBeVideo || cached.subMode !== subMode)) {
      this.cleanupPeerCard(slot.peerId, cached);
      this.cachedCards.delete(slot.peerId);
      cached = undefined;
    }

    let cardEl: HTMLElement;

    if (cached) {
      cardEl = cached.el;
      this.updateCardContentInPlace(cardEl, slot, shouldBeVideo, streamId, cached);
    } else {
      cardEl = this.createCardElement(slot, isFeatured);
      cached = { el: cardEl, isVideo: shouldBeVideo, streamId, subMode };
      this.cachedCards.set(slot.peerId, cached);
      if (shouldBeVideo) {
        const videoEl = cardEl.querySelector('video') as HTMLVideoElement | null;
        if (videoEl) {
          videoEl.play().catch(() => {});
        }
      }
    }

    this.bindCardInteractivity(cardEl, slot, isFeatured);

    // Non-destructive positional placement in target container
    const currentChild = targetContainer.children[targetIndex];
    if (currentChild !== cardEl) {
      if (currentChild) {
        targetContainer.insertBefore(cardEl, currentChild);
      } else {
        targetContainer.appendChild(cardEl);
      }
    }

    return cardEl;
  }

  private updateCardContentInPlace(
    cardEl: HTMLElement,
    slot: RoomSlotInfo,
    shouldBeVideo: boolean,
    streamId: string | undefined,
    cached: StreamCardCacheItem
  ): void {
    if (shouldBeVideo) {
      const videoEl = cardEl.querySelector('video') as HTMLVideoElement | null;
      if (videoEl && slot.stream) {
        if (videoEl.srcObject !== slot.stream) {
          videoEl.srcObject = slot.stream;
          cached.streamId = streamId;
          videoEl.play().catch(() => {});
        } else if (videoEl.paused) {
          videoEl.play().catch(() => {});
        }
      }
      if (!slot.isLocal && slot.stream) {
        audioContextManager.attachPeerAudio(slot.peerId, slot.stream);
      }

      // In-place name overlay update
      const overlayName =
        (cardEl.querySelector('.stream-user-name') as HTMLElement | null) ||
        (cardEl.querySelector('.stream-card-overlay span:nth-child(2)') as HTMLElement | null);
      if (overlayName && overlayName.textContent !== slot.senderName) {
        overlayName.textContent = slot.senderName;
      }

      // In-place watchers update
      const watchers = slot.watchers || [];
      const watchersCount = watchers.length;
      const watchersBadge = cardEl.querySelector('.stat-badge-watchers');
      if (watchersBadge) {
        const watchersText = watchersBadge.querySelector('.stat-watchers-text');
        if (watchersText) {
          watchersText.textContent = watchersCount === 1 ? '1 assistindo' : `${watchersCount} assistindo`;
        }
      }

      // In-place quality / ping update
      if (slot.isLocal) {
        const qualText = cardEl.querySelector('.stat-quality-text');
        if (qualText) {
          qualText.textContent = `${stateStore.currentResolution.label} ${formatFrameRate(stateStore.currentFps)} FPS`;
        }
      } else {
        const pingVal = this.callbacks.getPeerPing(slot.peerId);
        const pingText = cardEl.querySelector('.stat-ping-text');
        const pingDot = cardEl.querySelector('.stat-ping-dot');
        if (pingText && pingDot) {
          const pingNum = pingVal ?? 15;
          const pingStr = pingVal !== null && pingVal !== undefined ? `${pingVal} ms` : '15 ms';
          pingText.textContent = pingStr;
          pingDot.className = `stat-ping-dot ${pingNum < 80 ? 'ping-good' : pingNum < 180 ? 'ping-medium' : 'ping-poor'}`;
        }
      }
    } else {
      // In-place avatar card updates
      const label = cardEl.querySelector('.participant-avatar-label');
      if (label && label.textContent !== slot.senderName) {
        label.textContent = slot.senderName;
      }

      const watchers = slot.watchers || [];
      const watchersCount = watchers.length;
      const liveWatchersBadge = cardEl.querySelector('.badge-live-watchers');
      if (liveWatchersBadge) {
        const textSpan = liveWatchersBadge.querySelector('span');
        if (textSpan) {
          textSpan.textContent = `${watchersCount} assistindo`;
        }
      }
    }
  }

  private bindCardInteractivity(card: HTMLElement, slot: RoomSlotInfo, isFeatured: boolean): void {
    card.classList.toggle('featured', isFeatured);

    card.onclick = () => {
      if (stateStore.layoutMode === 'grid') {
        stateStore.pinnedPeerId = slot.peerId;
        stateStore.layoutMode = 'spotlight';
        this.renderRoomCards();
      } else {
        if (isFeatured) {
          stateStore.layoutMode = 'grid';
          stateStore.pinnedPeerId = null;
          this.renderRoomCards();
        } else {
          stateStore.pinnedPeerId = slot.peerId;
          this.renderRoomCards();
        }
      }
    };
  }

  private cleanupPeerCard(peerId: string, item: StreamCardCacheItem): void {
    const video = item.el.querySelector('video') as HTMLVideoElement | null;
    if (video) {
      this.cleanupVideoElement(video);
    }
    audioContextManager.detachPeerAudio(peerId);
    const parent = item.el.parentElement || (item.el as any).parentNode;
    if (parent) {
      parent.removeChild(item.el);
    }
    item.el.onclick = null;
  }

  private cleanupVideoElement(video: HTMLVideoElement): void {
    try {
      video.pause();
    } catch {}
    try {
      video.removeAttribute('src');
    } catch {}
    try {
      video.srcObject = null;
    } catch {}
    try {
      if (typeof video.load === 'function') {
        video.load();
      }
    } catch {}
  }

  private pruneContainer(container: HTMLElement): void {
    while (container.children.length > 0) {
      const child = container.children[container.children.length - 1];
      if (child) container.removeChild(child);
    }
  }

  private createCardElement(slot: RoomSlotInfo, isFeatured: boolean): HTMLElement {
    const isSubscribed = stateStore.subscribedStreams.has(slot.peerId);

    if (slot.isLocal) {
      if (slot.isStreaming && slot.stream) {
        const card = document.createElement('div');
        card.className = `stream-card ${isFeatured ? 'featured' : ''}`;
        card.setAttribute('data-peer-id', slot.peerId);

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = slot.stream;
        video.muted = true;

        const watchers = slot.watchers || [];
        const watchersCount = watchers.length;

        const statsHud = document.createElement('div');
        statsHud.className = 'stream-card-stats-hud';
        statsHud.innerHTML = `
          <span class="stat-badge stat-badge-quality">
            <span class="stat-badge-dot"></span>
            <span class="stat-quality-text">${stateStore.currentResolution.label} ${formatFrameRate(stateStore.currentFps)} FPS</span>
          </span>
          <span class="stat-badge stat-badge-watchers">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="stat-watchers-text">${watchersCount === 1 ? '1 assistindo' : `${watchersCount} assistindo`}</span>
          </span>
        `;

        const overlay = document.createElement('div');
        overlay.className = 'stream-card-overlay';
        overlay.innerHTML = `
          <span class="user-status-dot"></span>
          <span class="stream-user-name">${escapeHtml(slot.senderName)}</span>
          <span class="badge-you">VOCÊ</span>
        `;

        card.appendChild(video);
        card.appendChild(statsHud);
        card.appendChild(overlay);
        return card;
      } else {
        const card = document.createElement('div');
        card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
        card.setAttribute('data-peer-id', slot.peerId);
        card.style.setProperty('--user-color', slot.color);

        card.innerHTML = `
          <div class="participant-avatar-badge">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="participant-name-row">
            <span class="participant-avatar-label">${escapeHtml(slot.senderName)}</span>
            <span class="badge-you">VOCÊ</span>
          </div>
          <div class="participant-status-text">Você não está transmitindo</div>
        `;
        return card;
      }
    }

    // Remote peer
    if (slot.isStreaming) {
      if (isSubscribed && slot.stream) {
        const card = document.createElement('div');
        card.className = `stream-card ${isFeatured ? 'featured' : ''}`;
        card.setAttribute('data-peer-id', slot.peerId);

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = slot.stream;
        video.muted = true; // Crucial: Mute HTML video tag to prevent duplicate audio playout

        audioContextManager.attachPeerAudio(slot.peerId, slot.stream);
        const currentAudioState = audioContextManager.getPeerVolumeState(slot.peerId);

        const watchers = slot.watchers || [];
        const watchersCount = watchers.length;

        const pingVal = this.callbacks.getPeerPing(slot.peerId);
        const pingText = pingVal !== null && pingVal !== undefined ? `${pingVal} ms` : '15 ms';
        const pingClass = (pingVal ?? 15) < 80 ? 'ping-good' : (pingVal ?? 15) < 180 ? 'ping-medium' : 'ping-poor';

        const statsHud = document.createElement('div');
        statsHud.className = 'stream-card-stats-hud';
        statsHud.innerHTML = `
          <span class="stat-badge stat-badge-quality">
            <span class="stat-badge-dot"></span>
            <span class="stat-quality-text">1080p 60 FPS</span>
          </span>
          <span class="stat-badge stat-badge-ping">
            <span class="stat-ping-dot ${pingClass}"></span>
            <span class="stat-ping-text">${pingText}</span>
          </span>
          <span class="stat-badge stat-badge-watchers">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="stat-watchers-text">${watchersCount === 1 ? '1 assistindo' : `${watchersCount} assistindo`}</span>
          </span>
        `;

        const overlay = document.createElement('div');
        overlay.className = 'stream-card-overlay';
        overlay.innerHTML = `
          <span class="user-status-dot"></span>
          <span class="stream-user-name">${escapeHtml(slot.senderName)}</span>
        `;

        const stopBtn = document.createElement('button');
        stopBtn.className = 'btn-stop-watch-stream';
        stopBtn.setAttribute('aria-label', 'Parar de assistir esta transmissão');
        stopBtn.textContent = 'Parar de Assistir';
        stopBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          audioContextManager.detachPeerAudio(slot.peerId);
          stateStore.subscribedStreams.delete(slot.peerId);
          this.callbacks.onStopWatchingStream(slot.peerId);
          this.renderRoomCards();
        });

        // Interactive volume control with hover slider
        const volumeWrapper = document.createElement('div');
        volumeWrapper.className = 'stream-volume-controller';
        volumeWrapper.addEventListener('click', (e) => e.stopPropagation());

        const volumeBtn = document.createElement('button');
        volumeBtn.className = 'btn-stream-volume';
        volumeBtn.setAttribute('aria-label', 'Mutar / Desmutar');

        const updateVolumeIcon = (vol: number, isMuted: boolean) => {
          if (isMuted || vol === 0) {
            volumeBtn.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/>
              </svg>
            `;
          } else if (vol < 50) {
            volumeBtn.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
            `;
          } else {
            volumeBtn.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
              </svg>
            `;
          }
        };

        updateVolumeIcon(currentAudioState.volume, currentAudioState.isMuted);

        const sliderBox = document.createElement('div');
        sliderBox.className = 'stream-volume-slider-box';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.value = currentAudioState.isMuted ? '0' : currentAudioState.volume.toString();
        slider.className = 'stream-volume-range';

        const volumePercent = document.createElement('span');
        volumePercent.className = 'stream-volume-percent';
        volumePercent.textContent = `${slider.value}%`;

        let lastVolume = currentAudioState.volume || 100;

        slider.addEventListener('input', (e) => {
          e.stopPropagation();
          const val = parseInt(slider.value, 10);
          audioContextManager.setPeerVolume(slot.peerId, val, val === 0);
          if (val > 0) lastVolume = val;
          volumePercent.textContent = `${val}%`;
          updateVolumeIcon(val, val === 0);
        });

        volumeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const st = audioContextManager.getPeerVolumeState(slot.peerId);
          if (st.isMuted || st.volume === 0) {
            const targetVol = lastVolume || 100;
            audioContextManager.setPeerVolume(slot.peerId, targetVol, false);
            slider.value = targetVol.toString();
            volumePercent.textContent = `${targetVol}%`;
            updateVolumeIcon(targetVol, false);
          } else {
            lastVolume = st.volume || 100;
            audioContextManager.setPeerVolume(slot.peerId, 0, true);
            slider.value = '0';
            volumePercent.textContent = '0%';
            updateVolumeIcon(0, true);
          }
        });

        sliderBox.appendChild(slider);
        sliderBox.appendChild(volumePercent);
        volumeWrapper.appendChild(volumeBtn);
        volumeWrapper.appendChild(sliderBox);

        card.appendChild(video);
        card.appendChild(statsHud);
        card.appendChild(overlay);
        card.appendChild(stopBtn);
        card.appendChild(volumeWrapper);
        return card;
      } else if (isSubscribed && !slot.stream) {
        const card = document.createElement('div');
        card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
        card.setAttribute('data-peer-id', slot.peerId);
        card.style.setProperty('--user-color', slot.color);

        card.innerHTML = `
          <div class="participant-avatar-badge">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="participant-name-row">
            <span class="participant-avatar-label">${escapeHtml(slot.senderName)}</span>
          </div>
          <div class="participant-status-text" style="color: var(--accent-color);">Conectando transmissão...</div>
        `;

        this.callbacks.onRequestStream(slot.peerId);
        return card;
      } else {
        const card = document.createElement('div');
        card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
        card.setAttribute('data-peer-id', slot.peerId);
        card.style.setProperty('--user-color', slot.color);

        const watchers = slot.watchers || [];
        const watchersCount = watchers.length;

        card.innerHTML = `
          <span class="badge-live-stream">
            <span class="badge-live-dot"></span>AO VIVO
          </span>
          ${
            watchersCount > 0
              ? `
          <span class="badge-live-watchers">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>${watchersCount} assistindo</span>
          </span>
          `
              : ''
          }
          <div class="participant-avatar-badge">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="participant-name-row">
            <span class="participant-avatar-label">${escapeHtml(slot.senderName)}</span>
          </div>
          <div class="participant-action-row">
            <button class="btn-watch-stream" data-peer="${slot.peerId}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <span>Assistir Transmissão</span>
            </button>
          </div>
        `;

        const watchBtn = card.querySelector('.btn-watch-stream');
        watchBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          stateStore.subscribedStreams.add(slot.peerId);
          this.callbacks.onRequestStream(slot.peerId);
          this.renderRoomCards();
        });

        return card;
      }
    } else {
      const card = document.createElement('div');
      card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
      card.setAttribute('data-peer-id', slot.peerId);
      card.style.setProperty('--user-color', slot.color);

      card.innerHTML = `
        <div class="participant-avatar-badge">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
        </div>
        <div class="participant-name-row">
          <span class="participant-avatar-label">${escapeHtml(slot.senderName)}</span>
        </div>
        <div class="participant-status-text">Sem transmissão</div>
      `;

      return card;
    }
  }

  public clear(): void {
    this.cachedCards.forEach((cached, peerId) => {
      this.cleanupPeerCard(peerId, cached);
    });
    this.cachedCards.clear();

    const gridWrapper = document.getElementById('streams-grid-wrapper');
    const spotlightStage = document.getElementById('spotlight-stage');
    const featuredArea = document.getElementById('spotlight-featured-area');
    const trayStrip = document.getElementById('spotlight-tray-strip');

    if (gridWrapper) gridWrapper.innerHTML = '';
    if (featuredArea) featuredArea.innerHTML = '';
    if (trayStrip) trayStrip.innerHTML = '';
    if (spotlightStage) spotlightStage.classList.add('hidden');
    if (gridWrapper) gridWrapper.classList.remove('hidden');
  }
}
