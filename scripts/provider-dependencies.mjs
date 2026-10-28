import { readdir } from 'node:fs/promises'
import path from 'node:path'

/** Reject canvas packages and native binaries, including nested dependencies. */
export async function assertProviderDependencies(directory) {
  const forbidden = []
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isSymbolicLink()) throw new Error('Symlink in provider dependencies: ' + relative)
      if ((entry.isDirectory() && entry.name.toLowerCase() === 'canvas') || /\.(node|dll)$/i.test(entry.name)) forbidden.push(relative)
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative + '/')
    }
  }
  await walk(directory)
  if (forbidden.length) throw new Error('Forbidden canvas/native provider dependencies:\n' + forbidden.sort().join('\n'))
}
