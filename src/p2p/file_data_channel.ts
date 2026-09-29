const FILE_CHANNEL_LOW_WATER_BYTES = 1024 * 1024;

/** Keep enough data queued to fill a typical direct WAN path. */
export class FileOptimizedPeerConnection extends RTCPeerConnection {
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
    // Trystero assigns its default after createDataChannel/ondatachannel returns.
    queueMicrotask(() => {
      if (channel.readyState !== 'closed') {
        channel.bufferedAmountLowThreshold = FILE_CHANNEL_LOW_WATER_BYTES;
      }
    });
  }
}
