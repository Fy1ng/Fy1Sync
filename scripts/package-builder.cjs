/** Build-only adaptation of the pinned NSIS template. Never modifies node_modules. */
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const libraryRoot = path.join(root, 'node_modules', 'app-builder-lib')
const metadata = JSON.parse(readFileSync(path.join(libraryRoot, 'package.json'), 'utf8'))
const template = readFileSync(path.join(libraryRoot, 'templates', 'nsis', 'installer.nsi'), 'utf8')
const templateHash = '8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8'
const anchor = 'Function .onInit\n  Call setInstallSectionSpaceRequired\n\n  SetOutPath $INSTDIR\n'
const normalized = template.replaceAll('\r\n', '\n')
if (metadata.version !== '26.15.3' || createHash('sha256').update(template).digest('hex') !== templateHash
  || normalized.split(anchor).length !== 2) throw new Error('Pinned NSIS initialization template changed; review the path-safety adaptation before building')
// Initialize the public entry point first, avoiding circular partial exports when
// loading NsisTarget directly through app-builder-lib's platform packagers.
require(path.join(root, 'node_modules', 'electron-builder'))
const { NsisTarget } = require(path.join(libraryRoot, 'out', 'targets', 'nsis', 'NsisTarget.js'))
const computeFinalScript = NsisTarget.prototype.computeFinalScript
NsisTarget.prototype.computeFinalScript = function (source, ...args) {
  if (!this.isPortable) {
    if (source !== template) throw new Error('Unexpected NSIS template supplied to path-safety adaptation')
    // The stock .onInit creates /D before customInit can reject it. installSection.nsh
    // already sets $OUTDIR immediately before actual payload installation. Omit only
    // the premature write, preserving builder's normal two-stage uninstaller generation.
    source = normalized.replace(anchor, 'Function .onInit\n  Call setInstallSectionSpaceRequired\n\n  ; Destination is created only by installSection after path validation.\n')
  }
  return computeFinalScript.call(this, source, ...args)
}
if (process.argv.includes('--check')) {
  console.log('Verified pinned electron-builder26.15.3 NSIS initialization adaptation: ' + templateHash)
} else {
  require(path.join(root, 'node_modules', 'electron-builder', 'cli.js'))
}
