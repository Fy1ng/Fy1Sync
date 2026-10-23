/** Only a generated minimal application and verified tool resources enter the release. */
module.exports = {
  appId: 'cn.fy1ng.stream-syncer',
  productName: 'Stream Syncer',
  electronVersion: '44.9.0',
  electronDist: 'node_modules/electron/dist',
  directories: { app: '.packaging/app', output: '.release', buildResources: 'packaging' },
  asar: true,
  npmRebuild: false,
  files: [
    'package.json', 'electron/main.cjs', 'electron/preload.cjs', 'client/index.html',
    'client/assets/**/*.js', 'client/assets/**/*.css', 'client/assets/**/*.wasm',
    '!node_modules', '!node_modules/**/*',
  ],
  extraResources: [
    { from: '.packaging/tools', to: 'tools', filter: ['**/*', '!**/*.map', '!**/test/**', '!**/tests/**', '!**/.cache/**', '!**/*.tsbuildinfo'] },
  ],
  copyright: '',
  // Empty metadata clears Electron's upstream company field without inventing an owner/publisher.
  extraMetadata: { author: { name: '' } },
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], signExecutable: false },
  nsis: {
    artifactName: 'Stream-Syncer-${version}-win-x64-nsis.${ext}',
    oneClick: false, perMachine: false, allowElevation: false,
    allowToChangeInstallationDirectory: true, runAfterFinish: false,
    include: 'packaging/installer.nsh', packElevateHelper: false,
    createDesktopShortcut: false, createStartMenuShortcut: false,
    deleteAppDataOnUninstall: false,
  },
  artifactName: 'Stream-Syncer-${version}-win-x64-portable.${ext}',
  compression: 'normal',
  publish: null,
}
