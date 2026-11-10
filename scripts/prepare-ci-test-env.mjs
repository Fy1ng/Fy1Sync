import { appendFile, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const temporary = path.join(root, 'e2e', '.data', 'ci-temp')
await mkdir(temporary, { recursive: true })
// RUNNER~1 is an alias on hosted Windows. Strict private-path tests need a canonical root.
const canonical = await realpath(temporary)
const ffmpeg = path.join(root, '.packaging', 'tools', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = path.join(root, '.packaging', 'tools', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
if (!(await stat(ffmpeg)).isFile()) throw new Error('CI 媒体工具尚未准备')
if (!(await stat(ffprobe)).isFile()) throw new Error('CI 媒体探测工具尚未准备')
if (!process.env.STREAM_SYNC_FIXTURE_FFMPEG || !(await stat(process.env.STREAM_SYNC_FIXTURE_FFMPEG)).isFile()) throw new Error('CI 完整合成媒体编码器尚未准备')
for (const name of ['official.mp4', 'commentary.mp4']) if (!(await stat(path.join(root, 'public', 'test-sources', name))).isFile()) throw new Error('CI 合成媒体尚未准备')
if (!process.env.GITHUB_ENV) throw new Error('该脚本只准备 GitHub CI 测试环境')
await appendFile(process.env.GITHUB_ENV, `TEMP=${canonical}\nTMP=${canonical}\nTMPDIR=${canonical}\nSTREAM_SYNC_FFMPEG=${ffmpeg}\nSTREAM_SYNC_FFPROBE=${ffprobe}\n`)
console.log('已配置项目内的规范临时目录和独立测试媒体解码工具')
