export type DecodedJpegFrame = ImageBitmap | VideoFrame;

// ImageDecoder is not declared by the project's pinned TypeScript DOM library.
interface JpegImageDecoder {
  decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}
interface JpegImageDecoderConstructor {
  new(options: { data: Uint8Array; type: string; colorSpaceConversion: string }): JpegImageDecoder;
}

/** Preserve JPEG's decoded video planes instead of converting through an RGB bitmap. */
export class NativeJpegDecoder {
  private closed = false;
  private useBitmap = false;
  private pending = new Set<JpegImageDecoder>();
  private planes: Uint8Array | null = null;
  private readonly onFallback?: (error: unknown) => void;

  constructor(onFallback?: (error: unknown) => void) { this.onFallback = onFallback; }

  public async decode(buffer: ArrayBuffer): Promise<DecodedJpegFrame> {
    if (this.closed) throw new Error('JPEG capture decoder is closed');
    const Decoder = (globalThis as typeof globalThis & { ImageDecoder?: JpegImageDecoderConstructor }).ImageDecoder;
    if (Decoder && !this.useBitmap) {
      try {
        const decoder = new Decoder({ data: new Uint8Array(buffer), type: 'image/jpeg', colorSpaceConversion: 'none' });
        this.pending.add(decoder);
        try {
          const { image } = await decoder.decode({ frameIndex: 0 });
          if (this.closed) { image.close(); throw new Error('JPEG capture decoder is closed'); }
          return image;
        } finally {
          if (this.pending.delete(decoder)) decoder.close();
        }
      } catch (error) {
        if (this.closed) throw error;
        // Keep the same capture/track alive on older or incompatible WebViews.
        this.useBitmap = true;
        this.onFallback?.(error);
      }
    }
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }), {
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    if (this.closed) { bitmap.close(); throw new Error('JPEG capture decoder is closed'); }
    return bitmap;
  }

  /** Rebuild timed video planes: cloning an image frame can retain media timestamp zero. */
  public async createTrackFrame(frame: VideoFrame, init: VideoFrameInit): Promise<VideoFrame> {
    if (this.closed) throw new Error('JPEG capture decoder is closed');
    if (frame.format && !this.useBitmap) {
      try {
        const length = frame.allocationSize();
        if (this.planes?.byteLength !== length) this.planes = new Uint8Array(length);
        const planes = this.planes;
        const layout = await frame.copyTo(planes);
        if (this.closed) throw new Error('JPEG capture decoder is closed');
        // VideoFrame(ImageDecoder output, { timestamp }) can update only the JS
        // handle's clock in Chromium, leaving the underlying media frame at zero.
        // A frame built from video planes sets the media clock too, including
        // when the pacer reuses cached pixels. Retain YUV and reuse copy storage.
        return new VideoFrame(planes, { ...init, timestamp: init.timestamp ?? frame.timestamp,
          format: frame.format, codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
          visibleRect: frame.visibleRect ?? undefined, displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
          colorSpace: frame.colorSpace, layout });
      } catch (error) {
        if (this.closed) throw error;
        this.useBitmap = true;
        this.onFallback?.(error);
      }
    }
    const bitmap = await createImageBitmap(frame);
    try {
      if (this.closed) throw new Error('JPEG capture decoder is closed');
      return new VideoFrame(bitmap, init);
    } finally { bitmap.close(); }
  }

  public close(): void {
    this.closed = true;
    for (const decoder of this.pending) decoder.close();
    this.pending.clear();
    this.planes = null;
  }
}
