/** Only the selected video frame is captured, never the user's desktop. */
export function captureVideoFrame(video: HTMLVideoElement, maxWidth = 3840): string {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || !Number.isInteger(maxWidth) || maxWidth < 160 || maxWidth > 3840) throw new Error('当前视频帧不可用')
  const scale = Math.min(1, maxWidth / video.videoWidth, 2160 / video.videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.floor(video.videoHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法读取当前视频帧')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
