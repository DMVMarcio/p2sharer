import { attachIceDiagnostics } from './ice_config.ts';

const FILE_CHANNEL_LOW_WATER_BYTES = 1024 * 1024;

export interface FileOptimizedConnection extends RTCPeerConnection {
  roomDataChannel: RTCDataChannel | null;
}

export function ensureFileDataChannelWindow(connection: FileOptimizedConnection | null | undefined): boolean {
  const channel = connection?.roomDataChannel;
  if (!channel || channel.readyState !== 'open') return false;
  channel.bufferedAmountLowThreshold = FILE_CHANNEL_LOW_WATER_BYTES;
  return channel.bufferedAmountLowThreshold === FILE_CHANNEL_LOW_WATER_BYTES;
}

/** Keep enough data queued to fill a typical direct WAN path. */
export function createFileOptimizedPeerConnection(): (new (configuration?: RTCConfiguration) => FileOptimizedConnection) | undefined {
  if (typeof RTCPeerConnection === 'undefined') return undefined;
  return class FileOptimizedPeerConnection extends RTCPeerConnection {
    public roomDataChannel: RTCDataChannel | null = null;

    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      attachIceDiagnostics(this);
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
      // The inbound event may run this listener before Trystero sets its default.
      const apply = () => {
        if (channel.readyState !== 'closed') {
          channel.bufferedAmountLowThreshold = FILE_CHANNEL_LOW_WATER_BYTES;
        }
      };
      channel.addEventListener('open', apply);
      setTimeout(apply, 0);
    }
  };
}
