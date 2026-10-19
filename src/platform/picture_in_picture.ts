/** Keep the existing media node and main-window audio alive during browser PiP. */
export async function openBrowserPictureInPicture(video: HTMLVideoElement | null): Promise<void> {
  if (!video || !document.pictureInPictureEnabled || video.readyState < 2) throw new Error('Picture-in-picture unavailable');
  if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
  else await video.requestPictureInPicture();
}
