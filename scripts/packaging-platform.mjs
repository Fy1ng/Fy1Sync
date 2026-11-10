import { existsSync } from 'node:fs'
import path from 'node:path'
import macToolLock from '../packaging/tools-mac-lock.json' with { type: 'json' }

export const macMinimumSystemVersion = macToolLock.minimumSystemVersion
if (macMinimumSystemVersion !== '13.0') throw new Error('macOS 构建基线必须与 Electron 44 的 macOS 13 最低要求一致')

export function validateToolAsset(asset) {
  if (!asset || typeof asset.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name)
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1048576) throw new Error('Invalid locked asset')
  return asset
}

export function macNativeBuildEnvironment() {
  const minimumFlag = '-mmacosx-version-min=' + macMinimumSystemVersion
  return { MACOSX_DEPLOYMENT_TARGET: macMinimumSystemVersion, CC: '/usr/bin/clang', AR: '/usr/bin/ar', RANLIB: '/usr/bin/ranlib', CFLAGS: '-O3 ' + minimumFlag, LDFLAGS: minimumFlag }
}

export function packagingTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return { platform, arch, target: 'win32-x64', executableSuffix: '.exe', artifactPlatform: 'win' }
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return { platform, arch, target: `darwin-${arch}`, executableSuffix: '', artifactPlatform: 'mac' }
  if (platform === 'linux' && ['arm64', 'x64'].includes(arch)) return { platform, arch, target: `linux-${arch}`, executableSuffix: '', artifactPlatform: 'linux' }
  throw new Error('本地打包仅支持 Windows x64 或 macOS/Linux arm64/x64')
}

export function linuxConfigure(lock, arch) {
  packagingTarget('linux', arch)
  const omit = ['--target-os=', '--arch=', '--cc=', '--enable-schannel', '--disable-pthreads', '--enable-w32threads', '--cpu=', '--extra-cflags=', '--extra-ldflags=', '--extra-libs=']
  return [...lock.configure.filter(value => !omit.some(prefix => value.startsWith(prefix))),
    '--target-os=linux', `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`, '--cc=/usr/bin/gcc',
    '--enable-gnutls', '--enable-pthreads', '--disable-w32threads', '--disable-asm', '--enable-pic', '--disable-protocol=dtls,udp',
    '--extra-cflags=-fPIC -I../zlib-prefix/include', '--extra-ldflags=-L../zlib-prefix/lib']
}

export function linuxRuntimeFiles(lock) {
  return ['ffmpeg', 'ffprobe', ...Object.entries(lock.abi).map(([name, abi]) => `lib${name}.so.${abi.split('.')[0]}`)].sort()
}

export function nativeMacArch(args = [], arch = process.arch, platform = process.platform) {
  const target = packagingTarget(platform, arch)
  if (target.platform !== 'darwin') throw new Error('macOS 打包必须在 macOS 本机执行')
  const requested = args.filter(value => value.startsWith('--'))
  if (requested.some(value => !['--arm64', '--x64'].includes(value)) || requested.length > 1 || args.length !== requested.length) throw new Error('用法: npm run package:mac -- [--arm64|--x64]')
  if (requested.length && requested[0] !== '--' + arch) throw new Error('工具和 Electron 必须与当前 Node 架构一致, 请使用目标架构的原生 macOS 主机和 Node')
  return target
}

export function macConfigure(lock, arch) {
  packagingTarget('darwin', arch)
  const omit = ['--target-os=', '--arch=', '--cc=', '--enable-schannel', '--disable-pthreads', '--enable-w32threads', '--cpu=', '--extra-cflags=', '--extra-ldflags=', '--extra-libs=']
  return [
    ...lock.configure.filter(value => !omit.some(prefix => value.startsWith(prefix))),
    '--target-os=darwin', `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`, '--cc=/usr/bin/clang',
    '--enable-securetransport', '--enable-pthreads', '--disable-w32threads', '--disable-asm',
    `--extra-cflags=-mmacosx-version-min=${macMinimumSystemVersion} -I../zlib-prefix/include`,
    `--extra-ldflags=-mmacosx-version-min=${macMinimumSystemVersion} -L../zlib-prefix/lib -Wl,-rpath,@executable_path`,
    '--install-name-dir=@rpath',
  ]
}

export function macCapabilities(lock) {
  // Secure Transport implements TLS only; Schannel's implicit DTLS/UDP are not used by the app.
  return { ...lock.capabilities, protocol: lock.capabilities.protocol.filter(name => !['dtls', 'udp'].includes(name)) }
}

export function macRuntimeFiles(lock) {
  return ['ffmpeg', 'ffprobe', ...Object.entries(lock.abi).map(([name, abi]) => `lib${name}.${abi.split('.')[0]}.dylib`)].sort()
}

export function npmCliPath(environment = process.env, executable = process.execPath) {
  const candidates = [environment.npm_execpath,
    path.join(path.dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)
  const found = candidates.find(file => path.basename(file) === 'npm-cli.js' && existsSync(file))
  if (!found) throw new Error('找不到 npm-cli.js, 请通过 npm run 执行, 并安装完整的 Node.js/npm')
  return found
}
