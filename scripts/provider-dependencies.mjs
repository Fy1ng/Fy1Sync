import { open, readdir } from 'node:fs/promises'
import path from 'node:path'

const WASM_V1_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

async function isWasmModule(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(8)
    const { bytesRead } = await handle.read(header, 0, 8, 0)
    return bytesRead === 8 && header.equals(WASM_V1_MAGIC)
  } finally {
    await handle.close()
  }
}

/** Reject canvas packages and native binaries, including nested dependencies. */
export async function assertProviderDependencies(directory) {
  const forbidden = []
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name
      const fullPath = path.join(folder, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Symlink in provider dependencies: ' + relative)
      if (entry.isDirectory() && entry.name.toLowerCase() === 'canvas') {
        forbidden.push(relative)
      } else if (entry.isFile() && /\.(node|dll|dylib|so)$/i.test(entry.name)) {
        // quickjs-wasi names WASI guest WebAssembly modules *.so; allow only verified \0asm v1 modules there.
        const allowedWasm = /^(?:.*\/)?quickjs-wasi\/extensions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.so$/.test(relative)
          && await isWasmModule(fullPath)
        if (!allowedWasm) forbidden.push(relative)
      }
      if (entry.isDirectory()) await walk(fullPath, relative + '/')
    }
  }
  await walk(directory)
  if (forbidden.length) throw new Error('Forbidden canvas/native provider dependencies:\n' + forbidden.sort().join('\n'))
}
