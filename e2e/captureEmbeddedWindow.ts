import type { ElectronApplication } from '@playwright/test'
import type { View } from 'electron'

/** OSR and native child views can have different pixel scales, especially on Retina/HiDPI. */
export async function captureEmbeddedWindow(application: ElectronApplication, urlPrefix = '') {
  return application.evaluate(async ({ BrowserWindow, WebContentsView, nativeImage }, prefix) => {
    const main = BrowserWindow.getAllWindows()[0]!
    const descendants = (root: View): View[] => root.children.flatMap(child => [child, ...descendants(child)])
    const view = descendants(main.contentView).find(child => child instanceof WebContentsView && child.getVisible()
      && child.webContents.id !== main.webContents.id && child.webContents.getURL().startsWith(prefix)) as InstanceType<typeof WebContentsView> | undefined
    if (!view) throw new Error('Visible embedded surface is missing')
    const content = main.getContentBounds(), bounds = view.getBounds()
    if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
      || bounds.x + bounds.width > content.width || bounds.y + bounds.height > content.height) throw new Error('Embedded surface is outside the content area')
    const shell = (await main.capturePage()).toPNG()
    const native = (await view.webContents.capturePage()).toPNG()
    // Decode the PNGs at 1x so NativeImage representation metadata cannot change the scale.
    const pixels = nativeImage.createFromBuffer(shell).getSize()
    const scaled = nativeImage.createFromBuffer(native).resize({
      width: Math.round(bounds.width * pixels.width / content.width),
      height: Math.round(bounds.height * pixels.height / content.height), quality: 'best',
    }).toPNG()
    return { shell: shell.toString('base64'), native: native.toString('base64'), scaled: scaled.toString('base64'),
      bounds, content: { width: content.width, height: content.height } }
  }, urlPrefix)
}
