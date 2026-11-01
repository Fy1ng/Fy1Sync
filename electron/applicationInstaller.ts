import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { assertRegularPath, containedPath } from './privateStorage'
import { UPDATE_LIMITS } from './onlineUpdateContracts'

export function supportsApplicationInstall(options: { packaged: boolean; platform: string; arch: string; executable: string }): boolean {
  if (!options.packaged || options.platform !== 'win32' || options.arch !== 'x64') return false
  try {
    assertRegularPath(options.executable, false)
    const directory = path.dirname(options.executable)
    const uninstaller = containedPath(directory, path.join(directory, 'Uninstall Fy1Sync.exe'))
    assertRegularPath(uninstaller, false)
    return fs.statSync(uninstaller).size > 0
  } catch { return false }
}

/** Called only after native confirmation and a fresh signature/hash verification by the service. */
export async function launchApplicationInstaller(userDataDir: string, installer: string, launch: typeof spawn = spawn): Promise<void> {
  const directory = containedPath(userDataDir, path.join(userDataDir, 'online-updates', 'installers'))
  const file = containedPath(directory, installer)
  if (path.dirname(file) !== directory || !/^[a-f0-9]{64}\.exe$/.test(path.basename(file))) throw new Error('安装包路径无效.')
  assertRegularPath(file, false)
  // Shutdown may take time. Recheck the content-addressed file immediately before spawn.
  const handle = await fs.promises.open(file, 'r')
  try {
    const before = await handle.stat()
    if (before.nlink !== 1 || !before.isFile() || before.size < 1 || before.size > UPDATE_LIMITS.installerBytes) throw new Error('安装包已变化.')
    const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > before.size) throw new Error('安装包已变化.')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    assertRegularPath(containedPath(directory, file), false)
    const current = await fs.promises.stat(file)
    if (total !== before.size || after.mtimeMs !== before.mtimeMs || current.ino !== after.ino || current.size !== total
      || hash.digest('hex') !== path.basename(file, '.exe')) throw new Error('安装包未通过执行前校验.')
  } finally { await handle.close() }
  await new Promise<void>((resolve, reject) => {
    // No shell, silent-install flags, URL arguments, or elevation. NSIS owns its visible wizard.
    const child = launch(file, ['--updated', '/CURRENTUSER'], { shell: false, detached: true, windowsHide: true, stdio: 'ignore' })
    child.once('error', () => reject(new Error('安装向导未能启动, 没有安装更新.')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
