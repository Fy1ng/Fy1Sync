export type YtdlpReleaseAsset = 'yt-dlp.exe' | 'yt-dlp_x86.exe' | 'yt-dlp_arm64.exe' | 'yt-dlp_macos' | 'yt-dlp_linux' | 'yt-dlp_linux_aarch64'

/** Platform selection comes from main, never from renderer settings. */
export function ytdlpReleaseAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): YtdlpReleaseAsset | undefined {
  if (platform === 'darwin') return arch === 'x64' || arch === 'arm64' ? 'yt-dlp_macos' : undefined
  if (platform === 'linux') return arch === 'x64' ? 'yt-dlp_linux' : arch === 'arm64' ? 'yt-dlp_linux_aarch64' : undefined
  if (platform !== 'win32') return undefined
  return arch === 'x64' ? 'yt-dlp.exe' : arch === 'ia32' ? 'yt-dlp_x86.exe' : arch === 'arm64' ? 'yt-dlp_arm64.exe' : undefined
}

export function toolFilename(tool: 'ffmpeg' | 'ffprobe' | 'yt-dlp', platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${tool}.exe` : tool
}

export function toolSearchDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  // Finder-launched macOS applications usually do not inherit Homebrew's shell PATH.
  return [...new Set([...search.split(platform === 'win32' ? ';' : ':'), ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])])]
}
