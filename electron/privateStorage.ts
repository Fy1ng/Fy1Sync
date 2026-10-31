import fs from 'node:fs'
import path from 'node:path'

const pathFailure = () => new Error('账号数据路径无效.')

export function powershellEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
}

export function assertRegularPath(target: string, directory: boolean): void {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw pathFailure()
}

/** Validate every existing component before creating or accessing an app subtree. */
export function containedPath(root: string, target: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(target)
  const relative = path.relative(base, resolved)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw pathFailure()
  assertRegularPath(base, true)
  let cursor = base
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    try {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink()) throw pathFailure()
      const physical = path.relative(fs.realpathSync(base), fs.realpathSync(cursor))
      if (!physical || physical === '..' || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) throw pathFailure()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw pathFailure()
    }
  }
  return resolved
}

export function privateDirectory(root: string, target: string): string {
  const destination = containedPath(root, target)
  let cursor = path.resolve(root)
  for (const component of path.relative(cursor, destination).split(path.sep)) {
    cursor = path.join(cursor, component)
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 })
    assertRegularPath(cursor, true)
  }
  return destination
}
