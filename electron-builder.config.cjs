/** Only a generated minimal application and verified tool resources enter the release. */
module.exports = {
  appId: 'cn.fy1ng.fy1sync',
  productName: 'Fy1Sync',
  electronVersion: '44.9.3',
  electronDist: 'node_modules/electron/dist',
  directories: { app: '.packaging/app', output: '.release', buildResources: 'packaging' },
  asar: true,
  asarUnpack: ['electron/network-runtime.cjs'],
  npmRebuild: false,
  files: [
    'package.json', 'electron/main.cjs', 'electron/preload.cjs', 'electron/network-runtime.cjs', 'client/index.html',
    'client/assets/**/*.js', 'client/assets/**/*.css', 'client/assets/**/*.wasm', 'client/assets/**/*.woff2',
    '!node_modules', '!node_modules/**/*',
  ],
  extraResources: [
    { from: '.packaging/tools', to: 'tools', filter: ['**/*', '!**/*.map', '!**/test/**', '!**/tests/**', '!**/.cache/**', '!**/*.tsbuildinfo'] },
  ],
  copyright: '',
  // Empty metadata clears Electron's upstream company field without inventing an owner/publisher.
  extraMetadata: { author: { name: '' } },
  // The title bar's mark (scripts/make-icon.mjs) is the app, installer and uninstaller icon.
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], signExecutable: false, icon: 'packaging/icon.ico' },
  nsis: {
    artifactName: 'Fy1Sync-${version}-win-x64-nsis.${ext}',
    oneClick: false, perMachine: false, allowElevation: false,
    allowToChangeInstallationDirectory: true, runAfterFinish: false,
    include: 'packaging/installer.nsh', packElevateHelper: false,
    installerIcon: 'packaging/icon.ico', uninstallerIcon: 'packaging/icon.ico',
    // Chinese only, so the finish page's own label (desktop shortcut) reads as written.
    installerLanguages: ['zh_CN'], multiLanguageInstaller: false,
    // Start menu always; the desktop shortcut is asked on the finish page.
    createDesktopShortcut: false, createStartMenuShortcut: true, shortcutName: 'Fy1Sync',
    deleteAppDataOnUninstall: false,
  },
  artifactName: 'Fy1Sync-${version}-win-x64-portable.${ext}',
  compression: 'normal',
  publish: null,
}
