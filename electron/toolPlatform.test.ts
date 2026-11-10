import { describe, expect, it } from 'vitest'
import { toolFilename, toolSearchDirectories, ytdlpReleaseAsset } from './toolPlatform'

describe('desktop tool platform selection', () => {
  it.each([
    ['win32', 'x64', 'yt-dlp.exe'], ['win32', 'ia32', 'yt-dlp_x86.exe'], ['win32', 'arm64', 'yt-dlp_arm64.exe'],
    ['darwin', 'x64', 'yt-dlp_macos'], ['darwin', 'arm64', 'yt-dlp_macos'],
    ['linux', 'x64', 'yt-dlp_linux'], ['linux', 'arm64', 'yt-dlp_linux_aarch64'],
  ] as const)('selects the official asset for %s/%s', (platform, arch, asset) => {
    expect(ytdlpReleaseAsset(platform, arch)).toBe(asset)
  })

  it.each([['linux', 'ia32'], ['darwin', 'ia32'], ['win32', 'riscv64']] as const)('rejects unsupported managed updates on %s/%s', (platform, arch) => {
    expect(ytdlpReleaseAsset(platform, arch)).toBeUndefined()
  })

  it.each(['ffmpeg', 'ffprobe', 'yt-dlp'] as const)('uses native bundled filenames for %s', tool => {
    expect(toolFilename(tool, 'darwin')).toBe(tool)
    expect(toolFilename(tool, 'win32')).toBe(`${tool}.exe`)
  })

  it('preserves shell PATH precedence and adds both Homebrew locations for macOS GUI startup', () => {
    expect(toolSearchDirectories({ PATH: '/custom/bin:/usr/bin:/opt/homebrew/bin' }, 'darwin'))
      .toEqual(['/custom/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'])
    expect(toolSearchDirectories({}, 'darwin')).toEqual(['', '/opt/homebrew/bin', '/usr/local/bin'])
  })

  it('keeps Windows Path casing, drive separators and search directories unchanged', () => {
    expect(toolSearchDirectories({ Path: 'C:\\tools;D:\\tools' }, 'win32')).toEqual(['C:\\tools', 'D:\\tools'])
    expect(toolSearchDirectories({ PATH: '/custom:/usr/bin' }, 'linux')).toEqual(['/custom', '/usr/bin'])
  })
})
