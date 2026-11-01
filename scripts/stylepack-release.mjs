import { build } from 'vite'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const MAX_PACK_BYTES = 2 * 1_048_576
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_PACKS = 128
const SHA256_FILE = /^[a-f0-9]{64}\.json$/

/** Compile the same validators used by the installed client. No network requests are made. */
export async function loadReleaseValidators(workDir) {
  const directory = path.resolve(workDir ?? path.join(projectRoot, '.runtime-cache', `stylepack-release-${randomUUID()}`))
  await mkdir(directory, { recursive: true })
  const entry = path.join(directory, `entry-${randomUUID()}.mjs`)
  const output = `validators-${randomUUID()}.cjs`
  const source = name => JSON.stringify(path.join(projectRoot, ...name.split('/')).replaceAll('\\', '/'))
  await writeFile(entry, `export { parseHudStylePack } from ${source('src/core/hudStylePack.ts')};\nexport { parseStylePackSource, verifyStylePackCatalog } from ${source('electron/stylePackSync.ts')};\n`, { flag: 'wx' })
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

/** Refuse symbolic links and junctions in every existing component, including the leaf. */
async function regularPath(target, directory) {
  const absolute = path.resolve(target), parsed = path.parse(absolute)
  let cursor = parsed.root
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (let index = 0; index < components.length; index++) {
    cursor = path.join(cursor, components[index])
    let info
    try { info = await lstat(cursor) } catch (error) {
      if (error.code === 'ENOENT') return absolute
      throw new Error('无法检查发布路径.')
    }
    if (info.isSymbolicLink() || (index < components.length - 1 || directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error('发布路径必须使用普通文件和目录, 不允许符号链接或目录联接.')
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
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error('输入文件为空, 超过大小上限或不是普通文件.')
  const bytes = await readFile(file)
  if (bytes.length < 1 || bytes.length > limit) throw new Error('输入文件超过大小上限.')
  return bytes
}

async function jsonFile(file, limit) {
  const bytes = await limitedFile(file, limit)
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('输入 JSON 无法解析, 不会发布.') }
}

async function optionalManifest(directory) {
  const file = path.join(directory, 'manifest.json')
  try { return await limitedFile(file, MAX_MANIFEST_BYTES) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正安全整数.`)
  return value
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
  return value
}

function publicKeyFor(privateKey) {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('发布私钥必须使用 Ed25519.')
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
}

/** Keys are created only in the explicitly selected private directory, with exclusive files. */
export async function generateStylePackKeys(directory) {
  const destination = await makeDirectory(directory)
  const privatePath = path.join(destination, 'private-key.pem')
  const publicPath = path.join(destination, 'public-key.spki.txt')
  for (const file of [privatePath, publicPath]) {
    try { await lstat(file); throw new Error('目标目录已有密钥文件, 不会覆盖.') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const keys = generateKeyPairSync('ed25519')
  const publicKey = publicKeyFor(keys.privateKey)
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  await writeFile(privatePath, privatePem, { mode: 0o600, flag: 'wx' })
  try { await writeFile(publicPath, `${publicKey}\n`, { mode: 0o600, flag: 'wx' }) } catch (error) {
    // Remove only the private file created by this invocation after its companion fails.
    await regularPath(privatePath, false)
    await unlink(privatePath)
    throw error
  }
  return { privatePath, publicPath, publicKey }
}

async function assertPublicDestination(directory) {
  let names
  try { names = await readdir(directory) } catch (error) {
    if (error.code === 'ENOENT') return
    throw new Error('无法读取发布目录.')
  }
  if (names.some(name => !['manifest.json', 'packs'].includes(name))) throw new Error('发布目录包含非样式包文件, 请使用空目录或已有的样式包发布目录.')
  if (names.includes('manifest.json')) await regularPath(path.join(directory, 'manifest.json'), false)
  if (names.includes('packs')) {
    const packs = path.join(directory, 'packs')
    await regularPath(packs, true)
    for (const name of await readdir(packs)) {
      if (!SHA256_FILE.test(name)) throw new Error('发布目录包含非样式包文件.')
      const bytes = await limitedFile(path.join(packs, name), MAX_PACK_BYTES)
      if (`${createHash('sha256').update(bytes).digest('hex')}.json` !== name) throw new Error('发布目录中的内容寻址文件已损坏, 请改用新的空目录.')
    }
  }
}

async function immutablePack(directory, name, bytes) {
  const target = path.join(directory, name)
  await regularPath(target, false)
  try { await writeFile(target, bytes, { flag: 'wx', mode: 0o644 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await limitedFile(target, MAX_PACK_BYTES)).equals(bytes)) throw new Error('已有内容寻址文件与本次样式包不一致, 不会覆盖.')
  }
}

/** Build public data assets only; the signed manifest is committed last. */
export async function prepareStylePackRelease(options) {
  const validators = options.validators ?? await loadReleaseValidators(options.workDir)
  const revision = integer(options.revision, '清单版本')
  const inputDirectory = await regularPath(options.inputDirectory, true)
  const destination = await regularPath(options.destination, true)
  const privateKeyPath = await regularPath(options.privateKeyPath, false)
  if (within(destination, privateKeyPath) || within(destination, inputDirectory) || within(inputDirectory, destination)) {
    throw new Error('公开发布目录必须与私钥及输入素材目录隔离.')
  }
  let privateKey
  try { privateKey = createPrivateKey(await limitedFile(privateKeyPath, 16_384)) } catch {
    throw new Error('无法读取有效的发布私钥.')
  }
  const publicKey = publicKeyFor(privateKey)
  const source = validators.parseStylePackSource({ mirrors: options.mirrors, publicKey })
  if (!source) throw new Error('必须指定固定的 HTTPS 清单地址.')
  const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const minAppVersion = options.minAppVersion ?? pkg.version
  await assertPublicDestination(destination)
  const destinationManifest = await optionalManifest(destination)
  const previousCatalogs = []
  if (destinationManifest) previousCatalogs.push(validators.verifyStylePackCatalog(await jsonFile(path.join(destination, 'manifest.json'), MAX_MANIFEST_BYTES), source))
  if (options.previousManifest && path.resolve(options.previousManifest) !== path.join(destination, 'manifest.json')) {
    previousCatalogs.push(validators.verifyStylePackCatalog(await jsonFile(options.previousManifest, MAX_MANIFEST_BYTES), source))
  }
  const previousEntries = new Map()
  for (const previous of previousCatalogs) {
    if (revision <= previous.revision) throw new Error('新清单 revision 必须大于已签名清单的 revision.')
    for (const entry of previous.packs) {
      const old = previousEntries.get(entry.id)
      if (!old || entry.revision > old.revision) previousEntries.set(entry.id, entry)
      else if (old.revision === entry.revision && old.sha256 !== entry.sha256) throw new Error('提供的历史清单存在同版本不同内容, 请检查发布历史.')
    }
  }
  const names = (await readdir(inputDirectory)).filter(name => name.toLowerCase().endsWith('.json')).sort()
  if (names.length > MAX_PACKS) throw new Error('样式包数量超过 128 个上限.')
  if (!names.length && !options.allowEmpty) throw new Error('输入目录没有样式包 JSON; 如确需撤回全部包, 显式使用 --allow-empty.')
  const assets = [], ids = new Set()
  for (const name of names) {
    const raw = await jsonFile(path.join(inputDirectory, name), MAX_PACK_BYTES)
    const validation = validators.parseHudStylePack(raw)
    if (!validation.pack) throw new Error('输入样式包未通过生产格式校验, 不会发布.')
    const pack = validation.pack
    if (ids.has(pack.id)) throw new Error('输入目录中包含重复的样式包 ID.')
    ids.add(pack.id)
    const bytes = Buffer.from(`${JSON.stringify(sortKeys(pack))}\n`, 'utf8')
    if (bytes.length > MAX_PACK_BYTES) throw new Error('样式包超过 2 MiB 上限.')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const old = previousEntries.get(pack.id)
    const effectiveMinimum = options.minAppVersion === undefined && old?.revision === pack.revision ? old.minAppVersion : minAppVersion
    const entry = { id: pack.id, revision: pack.revision, sha256, bytes: bytes.length, path: `packs/${sha256}.json`, minAppVersion: effectiveMinimum }
    if (old && (pack.revision < old.revision || (pack.revision === old.revision && (sha256 !== old.sha256 || effectiveMinimum !== old.minAppVersion || bytes.length !== old.bytes)))) {
      throw new Error('样式包发生修改时必须递增其 revision, 且不能回退版本.')
    }
    assets.push({ bytes, entry })
  }
  assets.sort((left, right) => left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0)
  const catalog = { kind: 'fy1sync-stylepack-catalog', schemaVersion: 1, revision, packs: assets.map(asset => asset.entry) }
  const payload = Buffer.from(JSON.stringify(catalog), 'utf8')
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }
  const manifest = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  if (manifest.length > MAX_MANIFEST_BYTES) throw new Error('签名清单超过 256 KiB 上限.')
  validators.verifyStylePackCatalog(envelope, source)

  await makeDirectory(destination)
  const lockPath = path.join(destination, '.stylepack-release.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch { throw new Error('发布目录正被使用或有未清理的发布锁, 请先检查原有任务.') }
  const temporary = path.join(destination, `manifest-${randomUUID()}.tmp`)
  try {
    const currentManifest = await optionalManifest(destination)
    if (destinationManifest === null ? currentManifest !== null : currentManifest === null || !destinationManifest.equals(currentManifest)) {
      throw new Error('公开目录的清单已被其他发布任务修改, 请重新运行并递增版本.')
    }
    const packsDirectory = await makeDirectory(path.join(destination, 'packs'))
    for (const asset of assets) await immutablePack(packsDirectory, `${asset.entry.sha256}.json`, asset.bytes)
    const handle = await open(temporary, 'wx', 0o644)
    try { await handle.writeFile(manifest); await handle.sync() } finally { await handle.close() }
    await regularPath(path.join(destination, 'manifest.json'), false)
    await rename(temporary, path.join(destination, 'manifest.json'))
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    await lock.close()
    await regularPath(lockPath, false)
    await unlink(lockPath)
  }
  return { catalog, source, destination, manifestPath: path.join(destination, 'manifest.json'), packs: assets.length }
}

export const help = `赛事样式包离线发布工具

生成私钥和公钥, 仅在指定私有目录创建文件, 不覆盖已有密钥:
  node scripts/stylepack-release.mjs keygen --out <private-dir>

将已完成独立比赛验收并正式导出的 JSON 制作为静态分发文件:
  node scripts/stylepack-release.mjs prepare --input <pack-dir> --out <public-dir> --key <private-key.pem> --github-manifest-url <https://host/path/manifest.json> --gitcode-manifest-url <https://host/path/manifest.json> --revision <n>

可选参数:
  --previous <manifest.json>     前次已签名清单, 用于版本连续性校验
  --min-app-version <version>   最低客户端版本, 默认为项目版本
  --allow-empty                 显式撤回全部云端包

输出仅包含 manifest.json 和 packs/<sha256>.json. 必须先上传 packs, 再原子替换 manifest.json.
私钥始终保留本机, 公开托管和客户端仅使用公钥.
`

function argumentsFor(argv) {
  const options = {}, flags = new Set(['--allow-empty'])
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (!/^--[a-z-]+$/.test(name) || Object.hasOwn(options, name)) throw new Error('命令参数无效或重复.')
    if (flags.has(name)) { options[name] = true; continue }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('命令参数缺少值.')
    options[name] = value
  }
  return options
}

export async function runStylePackRelease(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { process.stdout.write(help); return }
  const command = argv[0], args = argumentsFor(argv.slice(1))
  if (command === 'keygen') {
    if (!args['--out'] || Object.keys(args).some(name => name !== '--out')) throw new Error('keygen 只接受 --out <private-dir>.')
    await generateStylePackKeys(args['--out'])
    process.stdout.write('密钥已创建到指定的私有目录. 私钥不会输出到终端.\n')
    return
  }
  if (!['prepare', 'build'].includes(command)) throw new Error('未知命令, 请使用 --help.')
  const allowed = ['--input', '--out', '--key', '--github-manifest-url', '--gitcode-manifest-url', '--revision', '--previous', '--min-app-version', '--allow-empty']
  if (Object.keys(args).some(name => !allowed.includes(name)) || ['--input', '--out', '--key', '--revision'].some(name => typeof args[name] !== 'string')
    || (!args['--github-manifest-url'] && !args['--gitcode-manifest-url'])) {
    throw new Error('prepare 参数缺失或包含未知选项, 请使用 --help.')
  }
  if (!/^[1-9][0-9]*$/.test(args['--revision'])) throw new Error('清单版本必须是正安全整数.')
  const result = await prepareStylePackRelease({
    inputDirectory: args['--input'], destination: args['--out'], privateKeyPath: args['--key'],
    mirrors: ['github', 'gitcode'].filter(id => args[`--${id}-manifest-url`]).map(id => ({ id, manifestUrl: args[`--${id}-manifest-url`] })),
    revision: Number(args['--revision']), previousManifest: args['--previous'], minAppVersion: args['--min-app-version'], allowEmpty: args['--allow-empty'] === true,
  })
  process.stdout.write(`已离线生成 ${result.packs} 个样式包, 清单 revision ${result.catalog.revision}. 尚未上传或发布.\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runStylePackRelease(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`样式包准备失败: ${error instanceof Error ? error.message : '未知错误'}\n`)
    process.exitCode = 1
  }
}
