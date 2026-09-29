const FILE_CHANNEL_LOW_WATER_BYTES = 1024 * 1024;

export interface FileOptimizedConnection extends RTCPeerConnection {
  roomDataChannel: RTCDataChannel | null;
}

/** Keep enough data queued to fill a typical direct WAN path. */
export function createFileOptimizedPeerConnection(): (new (configuration?: RTCConfiguration) => FileOptimizedConnection) | undefined {
  if (typeof RTCPeerConnection === 'undefined') return undefined;
  return class FileOptimizedPeerConnection extends RTCPeerConnection {
    public roomDataChannel: RTCDataChannel | null = null;

    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      this.addEventListener('datachannel', ({ channel }) => {
        this.tuneChannel(channel);
      });
    }

    override createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, options);
      this.tuneChannel(channel);
      return channel;
    }

    private tuneChannel(channel: RTCDataChannel): void {
      if (channel.label !== 'data') return;
      this.roomDataChannel = channel;
      // Trystero assigns its default after createDataChannel/ondatachannel returns.
      queueMicrotask(() => {
        if (channel.readyState !== 'closed') {
          channel.bufferedAmountLowThreshold = FILE_CHANNEL_LOW_WATER_BYTES;
        }
      });
    }
  };
}
