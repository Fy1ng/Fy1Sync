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
    'package.json', 'electron/main.cjs', 'electron/preload.cjs', 'electron/login-card-preload.cjs', 'electron/network-runtime.cjs', 'electron/icon.png', 'client/index.html',
    'client/assets/**/*.js', 'client/assets/**/*.css', 'client/assets/**/*.wasm', 'client/assets/**/*.woff2',
    '!node_modules', '!node_modules/**/*',
  ],
  extraResources: [
    { from: '.packaging/team-logos', to: 'team-logos', filter: ['manifest.json', 'events/logos/*.png', 'events/logos/*.jpg', 'events/logos/*.webp'] },
    { from: '.packaging/tools', to: 'tools', filter: ['**/*', '!**/*.map', '!**/test/**', '!**/tests/**', '!**/.cache/**', '!**/*.tsbuildinfo'] },
  ],
  copyright: '',
  // Empty metadata clears Electron's upstream company field without inventing an owner/publisher.
  extraMetadata: { author: { name: '' } },
  // OS and installer icons use the supplied artwork; the in-app title-bar mark stays unchanged.
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], signExecutable: false, icon: 'packaging/icon.ico' },
  mac: {
    minimumSystemVersion: require('./packaging/tools-mac-lock.json').minimumSystemVersion,
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    artifactName: 'Fy1Sync-${version}-mac-${arch}.${ext}',
    icon: 'packaging/icon-source.png', category: 'public.app-category.entertainment',
    // Normal electron-builder identity/notarization environment variables remain available.
    hardenedRuntime: true,
    extraFiles: [
      { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE.electron.txt' },
      { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
    ],
  },
  linux: {
    target: [{ target: 'deb', arch: ['x64', 'arm64'] }, { target: 'AppImage', arch: ['x64', 'arm64'] }, { target: 'tar.gz', arch: ['x64', 'arm64'] }],
    artifactName: 'Fy1Sync-${version}-linux-${arch}.${ext}',
    executableName: 'fy1sync', icon: 'packaging/icon-source.png', category: 'AudioVideo',
    maintainer: 'Fy1ng <dev@fy1ng.com>',
    synopsis: '电竞双路视频对齐播放器',
    description: '同步观看电竞赛事视频, 解说和弹幕.',
  },
  deb: {
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libgbm1', 'libasound2', 'libgnutls30', 'ca-certificates'],
  },
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
