import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { BrowserImportProfile, ImportBrowser } from './browserImportContracts'

export interface DiscoveredBrowserProfile extends BrowserImportProfile {
  directory: string
  database: string
  localState?: string
}
export interface BrowserProfileEnvironment { platform?: NodeJS.Platform; appData?: string; localAppData?: string }

async function regular(file: string, directory = false): Promise<boolean> {
  try { const stat = await fs.lstat(file); return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) }
  catch { return false }
}
async function json(file: string): Promise<Record<string, any>> {
  try {
    if (!await regular(file)) return {}
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) return {}
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function display(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || fallback : fallback
}
function id(browser: ImportBrowser, directory: string): string {
  return createHash('sha256').update(`${browser}:${path.resolve(directory).toLowerCase()}`).digest('hex').slice(0, 32)
}
function ini(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  let section: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]$/.exec(line.trim())
    if (header) { section = {}; result[header[1]!] = section; continue }
    const field = /^([^=;#]+)=(.*)$/.exec(line.trim())
    if (field) section[field[1]!.trim()] = field[2]!.trim()
  }
  return result
}

/** Discovery reads profile metadata only. Browser paths never become renderer capabilities. */
export async function discoverBrowserProfiles(environment: BrowserProfileEnvironment = {}): Promise<DiscoveredBrowserProfile[]> {
  if ((environment.platform ?? process.platform) !== 'win32') return []
  const local = environment.localAppData ?? process.env.LOCALAPPDATA
  const roaming = environment.appData ?? process.env.APPDATA
  if (!local || !roaming) return []
  const found: DiscoveredBrowserProfile[] = []
  for (const [browser, browserName, relative] of [
    ['edge', 'Microsoft Edge', 'Microsoft/Edge/User Data'],
    ['edge', 'Microsoft Edge Beta', 'Microsoft/Edge Beta/User Data'],
    ['edge', 'Microsoft Edge Dev', 'Microsoft/Edge Dev/User Data'],
    ['chrome', 'Google Chrome', 'Google/Chrome/User Data'],
    ['chrome', 'Google Chrome Beta', 'Google/Chrome Beta/User Data'],
    ['chrome', 'Google Chrome Dev', 'Google/Chrome Dev/User Data'],
    ['chrome', 'Google Chrome Canary', 'Google/Chrome SxS/User Data'],
  ] as const) {
    const root = path.join(local, relative)
    if (!await regular(root, true)) continue
    const stateFile = path.join(root, 'Local State')
    const state = await json(stateFile)
    const info = state.profile?.info_cache ?? {}
    const last = state.profile?.last_used
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^(Default|Profile \d+)$/.test(entry.name)) continue
      const directory = path.join(root, entry.name)
      const database = await regular(path.join(directory, 'Network', 'Cookies'))
        ? path.join(directory, 'Network', 'Cookies') : path.join(directory, 'Cookies')
      if (!await regular(database)) continue
      found.push({ id: id(browser, directory), browser, browserName,
        name: display(info[entry.name]?.name, entry.name), isDefault: last === entry.name || !last && entry.name === 'Default',
        directory, database, localState: stateFile })
    }
  }
  const firefoxRoots = [path.join(roaming, 'Mozilla', 'Firefox'),
    path.join(local, 'Packages', 'Mozilla.Firefox_n80bbvh6b1yt2', 'LocalCache', 'Roaming', 'Mozilla', 'Firefox')]
  for (const root of firefoxRoots) {
    if (!await regular(root, true)) continue
    const iniFile = path.join(root, 'profiles.ini')
    let profiles: Record<string, Record<string, string>> = {}
    if (await regular(iniFile) && (await fs.stat(iniFile)).size <= 1024 * 1024) profiles = ini(await fs.readFile(iniFile, 'utf8'))
    const defaults = Object.values(profiles).filter(value => value.Default && value.Locked === '1').map(value => path.resolve(root, value.Default!))
    const listed: { directory: string; name: string; isDefault: boolean }[] = []
    for (const [section, value] of Object.entries(profiles)) {
      if (!/^Profile\d+$/.test(section) || !value.Path) continue
      const directory = value.IsRelative === '0' ? path.resolve(value.Path) : path.resolve(root, value.Path)
      if (!await regular(directory, true)) continue
      listed.push({ directory, name: display(value.Name, path.basename(directory)),
        isDefault: value.Default === '1' || defaults.includes(directory) })
    }
    const entries = await fs.readdir(path.join(root, 'Profiles'), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const directory = path.join(root, 'Profiles', entry.name)
      if (!listed.some(profile => profile.directory === directory)) listed.push({ directory, name: display(entry.name, 'Firefox'), isDefault: false })
    }
    for (const profile of listed) {
      const database = path.join(profile.directory, 'cookies.sqlite')
      if (!await regular(database)) continue
      found.push({ ...profile, id: id('firefox', profile.directory), browser: 'firefox', browserName: 'Mozilla Firefox', database })
    }
  }
  const unique = [...new Map(found.map(profile => [profile.id, profile])).values()]
  return unique.sort((a, b) => a.browser.localeCompare(b.browser) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}
export function publicBrowserProfile(profile: DiscoveredBrowserProfile): BrowserImportProfile {
  const { id, browser, browserName, name, isDefault } = profile
  return { id, browser, browserName, name, isDefault }
}
