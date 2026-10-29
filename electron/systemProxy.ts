/** Best-effort source label only; Chromium remains responsible for actual routing. */
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

const SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const MAX_OUTPUT_BYTES = 32 * 1024
export interface RegistryOptions { windowsHide: true; timeout: number; maxBuffer: number; encoding: 'utf8' }
export type RegistryRunner = (file: string, args: readonly string[], options: RegistryOptions) => Promise<{ stdout: string }>
export interface SystemProxyOptions { platform?: NodeJS.Platform; run?: RegistryRunner }

const registryRunner: RegistryRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve({ stdout }))
})

/** Never returns or logs the PAC URL, proxy address, registry output or process errors. */
export async function systemProxyMode(options: SystemProxyOptions = {}): Promise<'PAC' | undefined> {
  if ((options.platform ?? process.platform) !== 'win32') return undefined
  const run = options.run ?? registryRunner
  const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const processOptions: RegistryOptions = { windowsHide: true, timeout: 3_000, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }
  const [script, connection] = await Promise.allSettled([
    run(executable, ['query', SETTINGS, '/v', 'AutoConfigURL'], processOptions),
    run(executable, ['query', `${SETTINGS}\\Connections`, '/v', 'DefaultConnectionSettings'], processOptions),
  ])
  const scriptOutput = script.status === 'fulfilled' ? script.value.stdout : ''
  const connectionOutput = connection.status === 'fulfilled' ? connection.value.stdout : ''
  const hasScript = /^\s*AutoConfigURL\s+REG_(?:EXPAND_)?SZ\s+\S[^\r\n]*$/im.test(scriptOutput)
  const blob = /^\s*DefaultConnectionSettings\s+REG_BINARY\s+([0-9a-f ]+)\s*$/im.exec(connectionOutput)?.[1]?.replaceAll(' ', '')
  if (blob && blob.length >= 24 && blob.length % 2 === 0) {
    // WinINet's default-connection blob starts with version, counter, then flags.
    // 0x04 enables an explicit script and 0x08 enables auto-detection (WPAD).
    const flags = Buffer.from(blob.slice(0, 24), 'hex').readUInt32LE(8)
    if (flags & 0x08 || flags & 0x04 && hasScript) return 'PAC'
    return undefined
  }
  // Some Windows profiles have the top-level URL without a default-connection blob.
  // This fallback is a source hint, not proof that a policy or a VPN uses that PAC.
  return hasScript ? 'PAC' : undefined
}
