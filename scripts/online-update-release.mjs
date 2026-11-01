import { build } from 'vite'
import { parse as parseHtml } from 'parse5'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const MAX_METADATA_BYTES = 256 * 1024
const MAX_FRONTEND_BYTES = 48 * 1024 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_DECODED_BYTES = 32 * 1024 * 1024
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
const MAX_HISTORY_ENTRIES = 1024
const MAX_HISTORY_BYTES = 64 * 1024 * 1024
const HISTORY_NAME = /^[1-9][0-9]{0,15}-[a-f0-9]{64}\.json$/
const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|wasm|woff2|png|jpg|jpeg|webp|svg|ico)$/
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Publisher and installed client use the same signature, path and compatibility validators. */
export async function loadOnlineUpdateValidators(workDir) {
  const directory = await makeDirectory(path.resolve(workDir ?? path.join(projectRoot, '.runtime-cache', `online-update-release-${randomUUID()}`)))
  const entry = path.join(directory, `entry-${randomUUID()}.mjs`)
  const output = `validators-${randomUUID()}.cjs`
  const source = name => JSON.stringify(path.join(projectRoot, ...name.split('/')).replaceAll('\\', '/'))
  await writeFile(entry, `export { parseOnlineUpdateSource, verifyOnlineUpdateCatalog, validateFrontendBundle } from ${source('electron/onlineUpdateManifest.ts')};\nexport { compareAppVersions } from ${source('electron/appUpdateService.ts')};\n`, { flag: 'wx' })
  await build({
    configFile: false, root: projectRoot, logLevel: 'warn', ssr: { noExternal: ['undici'] },
    build: {
      ssr: entry, outDir: directory, emptyOutDir: false, minify: false, sourcemap: false, target: 'node24',
      rollupOptions: { external: [/^node:/], output: { format: 'cjs', entryFileNames: output, codeSplitting: false } },
    },
  })
  return import(pathToFileURL(path.join(directory, output)).href)
}

function within(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

/** Check every existing component, not just the leaf, before accessing release data. */
async function regularPath(target, directory) {
  const absolute = path.resolve(target), parsed = path.parse(absolute)
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let cursor = parsed.root
  for (let index = 0; index < components.length; index++) {
    cursor = path.join(cursor, components[index])
    let info
    try { info = await lstat(cursor) } catch (error) {
      if (error.code === 'ENOENT') return absolute
      throw new Error('无法检查更新发布路径.')
    }
    if (info.isSymbolicLink() || ((index < components.length - 1 || directory) ? !info.isDirectory() : !info.isFile())) {
      throw new Error('更新发布路径只允许普通文件和目录, 不允许符号链接或目录联接.')
    }
  }
  return absolute
}

async function makeDirectory(directory) {
  await regularPath(directory, true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await regularPath(directory, true)
  return realpath(directory)
}

async function limitedFile(file, limit) {
  await regularPath(file, false)
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error('输入文件为空, 不是普通文件或超过大小上限.')
  const bytes = await readFile(file)
  if (bytes.length !== info.size || bytes.length > limit) throw new Error('输入文件在读取时发生变化或超过大小上限.')
  return bytes
}

async function jsonFile(file, limit = MAX_METADATA_BYTES) {
  const bytes = await limitedFile(file, limit)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('输入 JSON 无法解析, 不会发布.') }
}

async function optionalManifest(directory) {
  try { return await limitedFile(path.join(directory, 'manifest.json'), MAX_METADATA_BYTES) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正安全整数.`)
  return value
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

function publicKeyFor(key) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('应用更新发布私钥必须使用 Ed25519.')
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
}

/** Key generation is explicit and never replaces an existing application or data signing key. */
export async function generateOnlineUpdateKeys(directory) {
  const destination = await makeDirectory(directory)
  const privatePath = path.join(destination, 'private-key.pem')
  const publicPath = path.join(destination, 'public-key.spki.txt')
  for (const file of [privatePath, publicPath]) {
    try { await lstat(file); throw new Error('指定目录已有密钥, 不会覆盖.') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = publicKeyFor(privateKey)
  await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
  try { await writeFile(publicPath, `${publicKey}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
    await regularPath(privatePath, false)
    await unlink(privatePath)
    throw error
  }
  return { privatePath, publicPath, publicKey }
}

function checkedAssetName(name) {
  if (name.length > 180 || !ASSET_NAME.test(name) || name.includes('..') || DEVICE_NAME.test(name)) throw new Error('前端资源文件名不安全或不受支持.')
  return name
}

function checkResourceReference(raw, from, available, allowData = false) {
  if (typeof raw !== 'string' || !raw || /[\x00-\x20\x7f\\]/.test(raw)) throw new Error('前端资源引用无效.')
  if (allowData && raw.startsWith('data:')) return
  let target
  try { target = new URL(raw, `app://app/${from}`) } catch { throw new Error('前端资源引用无效.') }
  if (target.protocol !== 'app:' || target.hostname !== 'app' || target.username || target.password || target.port) {
    throw new Error('前端更新不能引用远程可执行资源或外部文件.')
  }
  let pathname
  try { pathname = decodeURIComponent(target.pathname).replace(/^\//, '') } catch { throw new Error('前端资源引用无效.') }
  if (!available.has(pathname)) throw new Error('前端更新引用了未收录的资源, 请重新构建完整前端.')
}

/** Catch incomplete build output before a valid signature could make it launchable. */
function checkFrontendReferences(files) {
  const available = new Set(files.map(file => file.path))
  const textFiles = new Map(files.filter(file => /\.(?:html|js|css|svg)$/.test(file.path)).map(file => [file.path, Buffer.from(file.content, 'base64').toString('utf8')]))
  const document = parseHtml(textFiles.get('index.html') ?? '')
  let hasRoot = false, hasEntry = false
  const visit = node => {
    const attrs = Object.fromEntries((node.attrs ?? []).map(attribute => [attribute.name, attribute.value]))
    if (attrs.id === 'root') hasRoot = true
    if (node.tagName === 'base') throw new Error('前端更新不能改变文档的资源根地址.')
    if (node.tagName === 'script') {
      if (attrs.src) { checkResourceReference(attrs.src, 'index.html', available); hasEntry = true }
      else if ((node.childNodes ?? []).some(child => child.value?.trim()) && !['application/json', 'application/ld+json'].includes(attrs.type)) {
        throw new Error('前端更新不允许内联脚本, 请使用构建后的独立资源.')
      }
    }
    if (node.tagName === 'link' && attrs.href && /\b(?:stylesheet|modulepreload|preload|icon)\b/i.test(attrs.rel ?? '')) {
      checkResourceReference(attrs.href, 'index.html', available, /\bicon\b/i.test(attrs.rel ?? ''))
    }
    if (node.tagName === 'img' && attrs.src) checkResourceReference(attrs.src, 'index.html', available, true)
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(document)
  if (!hasRoot || !hasEntry) throw new Error('前端更新缺少 #root 挂载点或脚本入口.')
  for (const [name, text] of textFiles) {
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)) throw new Error('前端资源疑似包含私钥, 不会发布.')
    if (name.endsWith('.css')) {
      for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g)) {
        checkResourceReference(match[1] ?? match[2] ?? match[3], name, available, true)
      }
      for (const match of text.matchAll(/@import\s+["']([^"']+)["']/g)) checkResourceReference(match[1], name, available)
    }
    if (name.endsWith('.js')) {
      // Vite chunk imports and dependency tables use literal build asset paths.
      for (const match of text.matchAll(/["']((?:\.\/|\/?assets\/)[A-Za-z0-9_.-]+\.(?:js|css|wasm|woff2|png|jpg|jpeg|webp|svg|ico))["']/g)) {
        const reference = match[1].startsWith('assets/') ? '/' + match[1] : match[1]
        checkResourceReference(reference, name, available)
      }
    }
  }
}

async function buildFrontend(options, metadata) {
  const input = await regularPath(options.clientDirectory, true)
  const files = [], seen = new Set()
  let decodedBytes = 0
  const add = async relative => {
    const bytes = await limitedFile(path.join(input, relative), MAX_FILE_BYTES)
    const folded = relative.toLowerCase()
    if (seen.has(folded)) throw new Error('前端资源包含大小写冲突的重复路径.')
    seen.add(folded)
    decodedBytes += bytes.length
    if (decodedBytes > MAX_DECODED_BYTES || files.length >= 512) throw new Error('前端更新超过资源数量或解码后大小上限.')
    files.push({ path: relative, content: bytes.toString('base64') })
  }
  await add('index.html')
  const assets = await regularPath(path.join(input, 'assets'), true)
  for (const name of (await readdir(assets)).sort()) {
    if (name.endsWith('.map')) continue
    checkedAssetName(name)
    await add(`assets/${name}`)
  }
  checkFrontendReferences(files)
  const bundle = { kind: 'fy1sync-frontend-bundle', schemaVersion: 1, revision: metadata.revision, version: metadata.version, bridgeVersion: metadata.bridgeVersion, files }
  const bytes = Buffer.from(`${JSON.stringify(bundle)}\n`)
  if (bytes.length > MAX_FRONTEND_BYTES) throw new Error('前端分发文件超过 48 MiB 上限.')
  const sha256 = digest(bytes)
  return { bytes, bundle, entry: { ...metadata, sha256, bytes: bytes.length, path: `frontends/${sha256}.json` } }
}

/** Hash and optionally copy from one bounded descriptor, without buffering a whole installer. */
async function installerDigest(file, destination) {
  await regularPath(file, false)
  const handle = await open(file, 'r')
  let output
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 64 || before.size > MAX_INSTALLER_BYTES) throw new Error('安装包不是有效的普通文件或超过 1 GiB 上限.')
    const header = Buffer.alloc(Math.min(before.size, 1024 * 1024))
    await handle.read(header, 0, header.length, 0)
    const pe = header.readUInt32LE(60)
    if (header.toString('ascii', 0, 2) !== 'MZ' || pe < 64 || pe > header.length - 4 || !header.subarray(pe, pe + 4).equals(Buffer.from('PE\0\0'))) {
      throw new Error('安装包必须是有效的 Windows PE 可执行文件.')
    }
    if (destination) {
      await regularPath(destination, false)
      output = await open(destination, 'wx', 0o644)
    }
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let bytes = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes)
      if (!bytesRead) break
      bytes += bytesRead
      if (bytes > MAX_INSTALLER_BYTES || bytes > before.size) throw new Error('安装包在读取时增大, 不会发布.')
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (output) await output.writeFile(chunk)
    }
    const after = await handle.stat()
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('安装包在读取时发生变化, 不会发布.')
    if (output) await output.sync()
    return { sha256: hash.digest('hex'), bytes }
  } finally { await handle.close(); await output?.close() }
}

async function assertPublicDestination(directory) {
  let names
  try { names = await readdir(directory) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (names.some(name => !['manifest.json', 'frontends', 'installers', 'history'].includes(name))) throw new Error('公开输出目录包含非更新发布文件, 请使用空目录或已有更新发布目录.')
  if (names.includes('manifest.json')) await regularPath(path.join(directory, 'manifest.json'), false)
  if (names.includes('history')) await regularPath(path.join(directory, 'history'), true)
  for (const kind of ['frontends', 'installers']) {
    if (!names.includes(kind)) continue
    const folder = await regularPath(path.join(directory, kind), true)
    const artifacts = await readdir(folder)
    if (artifacts.length > 512) throw new Error('发布目录的历史文件过多, 请另建输出目录并关联 --previous.')
    for (const name of artifacts) {
      if (!(kind === 'frontends' ? /^[a-f0-9]{64}\.json$/ : /^[a-f0-9]{64}\.exe$/).test(name)) throw new Error('公开输出目录包含非内容寻址文件.')
      const actual = kind === 'frontends' ? digest(await limitedFile(path.join(folder, name), MAX_FRONTEND_BYTES)) : (await installerDigest(path.join(folder, name))).sha256
      if (actual !== name.slice(0, 64)) throw new Error('已有发布文件已损坏, 不会覆盖或修改清单.')
    }
  }
}

async function removeTemporary(root, target) {
  if (path.dirname(target) !== root || !path.basename(target).startsWith('.online-update-')) throw new Error('临时发布文件路径无效.')
  try { await regularPath(target, false); await unlink(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function immutableFrontend(directory, name, bytes) {
  const target = path.join(directory, name)
  await regularPath(target, false)
  try {
    if (!(await limitedFile(target, MAX_FRONTEND_BYTES)).equals(bytes)) throw new Error('已有前端文件内容不一致, 不会覆盖.')
    return
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path.join(directory, `.online-update-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o644)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await regularPath(target, false)
    await rename(temporary, target)
  } finally { await removeTemporary(directory, temporary) }
}

async function immutableInstaller(directory, entry, input) {
  const target = path.join(directory, `${entry.sha256}.exe`)
  await regularPath(target, false)
  try {
    if (!same(await installerDigest(target), { sha256: entry.sha256, bytes: entry.bytes })) throw new Error('已有安装包内容不一致, 不会覆盖.')
    return
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path.join(directory, `.online-update-${randomUUID()}.tmp`)
  try {
    if (!same(await installerDigest(input, temporary), { sha256: entry.sha256, bytes: entry.bytes })) throw new Error('安装包在签名准备期间发生变化, 不会发布.')
    await regularPath(target, false)
    await rename(temporary, target)
  } finally { await removeTemporary(directory, temporary) }
}

function signedProof(bytes, directory, validators, source) {
  let envelope
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('历史签名清单无法解析.') }
  const catalog = validators.verifyOnlineUpdateCatalog(envelope, source)
  const name = `${catalog.revision}-${digest(Buffer.from(envelope.payload, 'base64'))}.json`
  return { catalog, envelope, directory, name, bytes: Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`) }
}

async function signedHistory(directory, validators, source) {
  const history = await regularPath(path.join(directory, 'history'), true)
  let names
  try { names = await readdir(history) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  if (names.length > MAX_HISTORY_ENTRIES) throw new Error('签名发布历史超过 1024 条上限, 不会丢弃历史或继续签名.')
  const proofs = []
  let total = 0
  for (const name of names.sort()) {
    if (!HISTORY_NAME.test(name)) throw new Error('发布历史目录只允许不可变签名清单, 不允许其他文件.')
    const bytes = await limitedFile(path.join(history, name), MAX_METADATA_BYTES)
    total += bytes.length
    if (total > MAX_HISTORY_BYTES) throw new Error('签名发布历史超过 64 MiB 上限, 不会丢弃历史或继续签名.')
    const proof = signedProof(bytes, directory, validators, source)
    if (proof.name !== name) throw new Error('发布历史文件名与签名 revision 或 payload 哈希不一致.')
    proofs.push(proof)
  }
  return proofs
}

function uniqueHistory(proofs) {
  const entries = new Map(), revisions = new Map()
  let total = 0
  for (const proof of proofs) {
    const previous = revisions.get(proof.catalog.revision)
    if (previous !== undefined && previous !== proof.name) throw new Error('历史清单存在同版本不同签名 payload, 请检查发布历史.')
    revisions.set(proof.catalog.revision, proof.name)
    if (entries.has(proof.name)) {
      if (!same(entries.get(proof.name).envelope, proof.envelope)) throw new Error('历史清单签名存在冲突.')
      continue
    }
    total += proof.bytes.length
    if (entries.size >= MAX_HISTORY_ENTRIES || total > MAX_HISTORY_BYTES) throw new Error('签名发布历史超过数量或大小上限, 不会丢弃历史或继续签名.')
    entries.set(proof.name, proof)
  }
  return [...entries.values()].sort((a, b) => a.catalog.revision - b.catalog.revision)
}

/** Null withdraws a channel but never clears its authenticated version high-water mark. */
function assertHistory(proofs, compareVersions) {
  let previous = null, frontend = null, application = null
  for (const proof of proofs) {
    const current = proof.catalog
    if (current.frontend) {
      if (frontend && (current.frontend.revision < frontend.revision || current.frontend.revision === frontend.revision
        && (!same(frontend, current.frontend) || previous?.frontend === null))) {
        throw new Error('历史前端更新存在回退, 同版本不同内容或撤回后复用旧版本; 请提高前端 revision 或显式撤回.')
      }
      frontend = current.frontend
    }
    if (current.application) {
      const compared = application ? compareVersions(current.application.version, application.version) : 1
      if (compared < 0 || compared === 0 && (!same(application, current.application) || previous?.application === null)) {
        throw new Error('历史安装包存在回退, 同版本不同内容或撤回后复用旧版本; 请提高应用版本或显式撤回.')
      }
      application = current.application
    }
    previous = current
  }
}

async function immutableHistory(directory, proof) {
  const target = path.join(directory, proof.name)
  await regularPath(target, false)
  try {
    if (!same(await jsonFile(target), proof.envelope)) throw new Error('已有历史签名清单内容不一致, 不会覆盖.')
    return
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path.join(directory, `.online-update-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o644)
    try { await handle.writeFile(proof.bytes); await handle.sync() } finally { await handle.close() }
    await regularPath(target, false)
    await rename(temporary, target)
  } finally { await removeTemporary(directory, temporary) }
}

/** Prepare authenticated artifacts locally. No request, Git command or release upload is performed. */
export async function prepareOnlineUpdateRelease(options) {
  const validators = options.validators ?? await loadOnlineUpdateValidators(options.workDir)
  const catalogRevision = positive(options.catalogRevision, '清单 revision ')
  const destination = await regularPath(options.destination, true)
  const privateKeyPath = await regularPath(options.privateKeyPath, false)
  const sourcePath = await regularPath(options.sourcePath, false)
  if (within(destination, privateKeyPath) || within(path.dirname(privateKeyPath), destination)
    || within(destination, sourcePath) || within(path.dirname(sourcePath), destination)
    || options.clientDirectory && (within(destination, options.clientDirectory) || within(options.clientDirectory, destination))) {
    throw new Error('公开输出必须与私钥目录, 来源配置目录和前端输入目录隔离.')
  }
  if (options.dropFrontend && options.clientDirectory || options.dropApplication && (options.applicationDescriptorPath || options.installerPath)) throw new Error('不能同时更新和撤回同一个通道.')
  if (!!options.applicationDescriptorPath !== !!options.installerPath) throw new Error('完整应用更新必须同时指定 --application 和 --installer.')
  if (!options.clientDirectory && [options.revision, options.frontendVersion, options.minAppVersion, options.maxAppVersion, options.notesPath].some(value => value !== undefined)) throw new Error('前端版本参数必须与 --client 一起使用.')
  let privateKey
  try { privateKey = createPrivateKey(await limitedFile(privateKeyPath, 16_384)) } catch { throw new Error('无法读取有效的应用更新发布私钥.') }
  const publicKey = publicKeyFor(privateKey)
  const source = validators.parseOnlineUpdateSource(await jsonFile(sourcePath, 16_384))
  if (!source || source.publicKey !== publicKey) throw new Error('发布私钥与来源配置的公钥不匹配.')
  const stylePackSource = JSON.parse(await readFile(path.join(projectRoot, 'packaging/stylepack-source.json'), 'utf8'))
  if (stylePackSource?.publicKey === publicKey) throw new Error('应用代码更新必须使用独立签名密钥, 不能复用样式包密钥.')
  const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const baseline = JSON.parse(await readFile(path.join(projectRoot, 'packaging/frontend-build.json'), 'utf8'))
  positive(baseline.revision, '内置前端 revision ')
  positive(baseline.bridgeVersion, 'IPC bridgeVersion ')
  await assertPublicDestination(destination)
  const destinationManifest = await optionalManifest(destination)
  const destinationHistory = await signedHistory(destination, validators, source)
  const visibleManifests = [], importedHistory = []
  if (destinationManifest) visibleManifests.push(signedProof(destinationManifest, destination, validators, source))
  if (options.previousManifest && path.resolve(options.previousManifest) !== path.join(destination, 'manifest.json')) {
    const previousPath = path.resolve(options.previousManifest)
    const containingDirectory = path.dirname(previousPath)
    const previousDirectory = path.basename(containingDirectory) === 'history' && HISTORY_NAME.test(path.basename(previousPath)) ? path.dirname(containingDirectory) : containingDirectory
    visibleManifests.push(signedProof(await limitedFile(previousPath, MAX_METADATA_BYTES), previousDirectory, validators, source))
    if (previousDirectory !== destination) importedHistory.push(...await signedHistory(previousDirectory, validators, source))
  }
  const previousCatalogs = uniqueHistory([...destinationHistory, ...importedHistory, ...visibleManifests])
  assertHistory(previousCatalogs, validators.compareAppVersions)
  if (previousCatalogs.some(proof => catalogRevision <= proof.catalog.revision)) throw new Error('新清单 revision 必须大于全部已签名历史清单, 包括未完成发布的预留版本.')
  // A signed reservation from a failed preparation must not resurrect an inactive channel.
  const previous = [...visibleManifests].sort((a, b) => a.catalog.revision - b.catalog.revision).at(-1)
  let frontend = options.dropFrontend ? null : previous?.catalog.frontend ?? null
  let frontendBytes = null
  if (options.clientDirectory) {
    const revision = positive(options.revision, '前端 revision ')
    if (revision <= baseline.revision || previousCatalogs.some(item => item.catalog.frontend && revision <= item.catalog.frontend.revision)) throw new Error('新前端 revision 必须大于内置版本和历史前端版本.')
    const notes = options.notesPath ? new TextDecoder('utf-8', { fatal: true }).decode(await limitedFile(options.notesPath, 32_768)).trim() : ''
    const built = await buildFrontend(options, {
      revision, version: options.frontendVersion ?? pkg.version, bridgeVersion: baseline.bridgeVersion,
      minAppVersion: options.minAppVersion ?? pkg.version, maxAppVersion: options.maxAppVersion ?? pkg.version, notes,
    })
    validators.validateFrontendBundle(built.bundle, built.entry)
    frontend = built.entry
    frontendBytes = built.bytes
  } else if (frontend) {
    const locations = [destination, ...previousCatalogs.filter(item => same(item.catalog.frontend, frontend)).map(item => item.directory)]
    for (const directory of locations) {
      try { frontendBytes = await limitedFile(path.join(directory, frontend.path), MAX_FRONTEND_BYTES); break } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!frontendBytes || frontendBytes.length !== frontend.bytes || digest(frontendBytes) !== frontend.sha256) throw new Error('保留的前端包缺失或已损坏; --previous 应指向保留完整资源的发布目录.')
    validators.validateFrontendBundle(JSON.parse(frontendBytes.toString('utf8')), frontend)
  }
  let application = options.dropApplication ? null : previous?.catalog.application ?? null
  if (options.applicationDescriptorPath) {
    const descriptor = await jsonFile(options.applicationDescriptorPath)
    if (!object(descriptor) || Object.keys(descriptor).length !== 5 || Object.keys(descriptor).some(key => !['version', 'platform', 'arch', 'notes', 'downloads'].includes(key))) {
      throw new Error('安装包描述只允许 version, platform, arch, notes, downloads; 哈希和大小由工具计算.')
    }
    if (!options.installerPath.toLowerCase().endsWith('.exe')) throw new Error('安装包必须是 .exe 文件.')
    application = { ...descriptor, ...await installerDigest(options.installerPath) }
    for (const old of previousCatalogs.map(item => item.catalog.application).filter(Boolean)) {
      const compared = validators.compareAppVersions(application.version, old.version)
      if (compared < 0 || compared === 0 && (!same(application, old) || previous?.catalog.application === null)) throw new Error('安装包变更或撤回后重新发布时必须提高应用版本, 不允许降级或复用旧版本.')
    }
  }
  if (!previous && !frontend && !application && !options.dropFrontend && !options.dropApplication) throw new Error('必须指定前端, 安装包或显式撤回通道, 不会误发布空清单.')
  const catalog = { kind: 'fy1sync-update-catalog', schemaVersion: 1, revision: catalogRevision, frontend, application }
  const payload = Buffer.from(JSON.stringify(canonical(catalog)))
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }
  const manifest = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)
  if (manifest.length > MAX_METADATA_BYTES) throw new Error('签名更新清单超过 256 KiB 上限.')
  const newProof = signedProof(manifest, destination, validators, source)
  const nextHistory = uniqueHistory([...previousCatalogs, newProof])
  assertHistory(nextHistory, validators.compareAppVersions)

  await makeDirectory(destination)
  const lockPath = path.join(destination, '.online-update-release.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch { throw new Error('发布目录正被使用或残留发布锁, 请先检查原有任务.') }
  const temporary = path.join(destination, `.online-update-${randomUUID()}.tmp`)
  try {
    const currentManifest = await optionalManifest(destination)
    if (destinationManifest === null ? currentManifest !== null : currentManifest === null || !destinationManifest.equals(currentManifest)) throw new Error('输出目录清单已被其他任务修改, 请重新检查发布版本.')
    const currentHistory = await signedHistory(destination, validators, source)
    if (!same(currentHistory.map(proof => [proof.name, proof.envelope]), destinationHistory.map(proof => [proof.name, proof.envelope]))) throw new Error('输出目录签名历史已被其他任务修改, 请重新检查发布版本.')
    const historyDirectory = await makeDirectory(path.join(destination, 'history'))
    // Signed versions are reserved before artifact or manifest publication can fail.
    for (const proof of nextHistory) await immutableHistory(historyDirectory, proof)
    if (frontendBytes && frontend) await immutableFrontend(await makeDirectory(path.join(destination, 'frontends')), `${frontend.sha256}.json`, frontendBytes)
    if (options.installerPath && application) await immutableInstaller(await makeDirectory(path.join(destination, 'installers')), application, options.installerPath)
    const handle = await open(temporary, 'wx', 0o644)
    try { await handle.writeFile(manifest); await handle.sync() } finally { await handle.close() }
    await regularPath(path.join(destination, 'manifest.json'), false)
    await rename(temporary, path.join(destination, 'manifest.json'))
  } finally {
    await removeTemporary(destination, temporary)
    await lock.close()
    await regularPath(lockPath, false)
    await unlink(lockPath)
  }
  return { catalog, source, destination, manifestPath: path.join(destination, 'manifest.json') }
}

export const help = `应用更新离线发布工具

生成独立的 Ed25519 应用发布密钥, 不覆盖已有密钥:
  node scripts/online-update-release.mjs keygen --out <private-dir>

生成签名前端更新:
  node scripts/online-update-release.mjs prepare --client dist/client --revision <n> --catalog-revision <n> --out <public-dir> --key <private-key.pem> --source <source.json>

生成完整应用更新, 省略 --client 时保留上次的前端通道:
  node scripts/online-update-release.mjs prepare --application <descriptor.json> --installer <setup.exe> --catalog-revision <n> --out <public-dir> --key <private-key.pem> --source <source.json>

可选参数:
  --previous <manifest.json>       前次签名清单, 所在目录须保留其前端资源和 history/
  --frontend-version <version>     前端显示版本, 默认为项目版本
  --min-app-version <version>      最低客户端版本, 默认为项目版本
  --max-app-version <version>      最高客户端版本, 默认为项目版本
  --notes <utf8.txt>               前端发布说明
  --drop-frontend                  显式撤回前端通道, 不删除已下载文件
  --drop-application               显式撤回完整应用通道

省略某个通道表示保留, 不表示撤回. 完整安装包描述包含 version, platform, arch, notes, downloads.
history/<revision>-<payload-sha256>.json 保留不可变签名历史, 撤回或准备失败不重置版本.
先上传 frontends/<sha256>.json 和安装包附件, 校验两源可下载, 最后发布同一份 manifest.json.
本工具只生成本地文件, 不联网, 不上传, 不执行 Git 命令或安装包. 私钥不进入输出目录.
`

function argumentsFor(argv) {
  const args = {}, flags = new Set(['--drop-frontend', '--drop-application'])
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (!/^--[a-z-]+$/.test(name) || Object.hasOwn(args, name)) throw new Error('命令参数无效或重复.')
    if (flags.has(name)) { args[name] = true; continue }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('命令参数缺少值.')
    args[name] = value
  }
  return args
}

export async function runOnlineUpdateRelease(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { process.stdout.write(help); return }
  const command = argv[0], args = argumentsFor(argv.slice(1))
  if (command === 'keygen') {
    if (!args['--out'] || Object.keys(args).some(key => key !== '--out')) throw new Error('keygen 只接受 --out <private-dir>.')
    await generateOnlineUpdateKeys(args['--out'])
    process.stdout.write('应用更新密钥已生成到指定私有目录. 私钥不会输出到终端.\n')
    return
  }
  if (command !== 'prepare') throw new Error('未知命令, 请使用 --help.')
  const allowed = ['--client', '--revision', '--catalog-revision', '--out', '--key', '--source', '--previous', '--min-app-version', '--max-app-version', '--frontend-version', '--notes', '--application', '--installer', '--drop-frontend', '--drop-application']
  if (Object.keys(args).some(name => !allowed.includes(name)) || ['--out', '--key', '--source', '--catalog-revision'].some(name => typeof args[name] !== 'string')) throw new Error('prepare 参数缺失或包含未知选项, 请使用 --help.')
  for (const key of ['--catalog-revision', '--revision']) if (args[key] !== undefined && !/^[1-9][0-9]*$/.test(args[key])) throw new Error('revision 必须是正安全整数.')
  const result = await prepareOnlineUpdateRelease({
    destination: args['--out'], privateKeyPath: args['--key'], sourcePath: args['--source'], catalogRevision: Number(args['--catalog-revision']),
    clientDirectory: args['--client'], revision: args['--revision'] === undefined ? undefined : Number(args['--revision']),
    frontendVersion: args['--frontend-version'], minAppVersion: args['--min-app-version'], maxAppVersion: args['--max-app-version'], notesPath: args['--notes'],
    previousManifest: args['--previous'], applicationDescriptorPath: args['--application'], installerPath: args['--installer'],
    dropFrontend: args['--drop-frontend'] === true, dropApplication: args['--drop-application'] === true,
  })
  process.stdout.write(`已离线生成应用更新清单 revision ${result.catalog.revision}. 尚未上传或发布.\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runOnlineUpdateRelease(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`更新发布准备失败: ${error instanceof Error ? error.message : '未知错误'}\n`)
    process.exitCode = 1
  }
}
