export class NativeVideoBridge {
  private activeStream: MediaStream | null = null;

  public async startCapture(
    _sourceId: string,
    fps: number,
    resolution: { width: number; height: number },
    captureMouse: boolean = true,
    _quality: number = 92
  ): Promise<MediaStream> {
    this.stop();

    // Direct GPU Hardware-Accelerated Capture (Windows Graphics Capture / DXGI)
    const constraints: DisplayMediaStreamOptions = {
      video: {
        frameRate: { ideal: fps, max: fps },
        width: { ideal: resolution.width, max: resolution.width },
        height: { ideal: resolution.height, max: resolution.height },
        // @ts-expect-error cursor is valid in modern Chromium
        cursor: captureMouse ? 'always' : 'never',
      },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        // Force high framerate motion priority in WebRTC
        if ('contentHint' in videoTrack) {
          videoTrack.contentHint = 'motion';
        }
      }
      this.activeStream = stream;
      return stream;
    } catch (err) {
      console.error('Failed to get hardware display media:', err);
      throw err;
    }
  }

  public stop(): void {
    if (this.activeStream) {
      this.activeStream.getTracks().forEach((t) => t.stop());
      this.activeStream = null;
    }
  }
}
