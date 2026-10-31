/** Layout operations keep the pack's shared bitmap namespace intact. */
import { parseHudStylePack, type HudSize, type HudStylePack, type HudVariant } from '../../core/hudStylePack'

export function editorVariant(pack: HudStylePack, variantId = pack.variants[0]!.id): HudVariant {
  return pack.variants.find(variant => variant.id === variantId) ?? pack.variants[0]!
}

export function addLayout(pack: HudStylePack, variantId: string, size: HudSize): { pack: HudStylePack; id: string } {
  const current = editorVariant(pack, variantId)
  let index = 1
  while (pack.variants.some(variant => variant.id === `layout-${index}`)) index++
  const id = `layout-${index}`
  const sameSize = current.nativeSize.width === size.width && current.nativeSize.height === size.height
  const variant: HudVariant = sameSize ? { ...structuredClone(current), id, organizer: null }
    : { id, nativeSize: { width: size.width, height: size.height }, fields: { clock: null, scoreLeft: null, scoreRight: null }, cues: {}, states: {}, organizer: null }
  return { pack: { ...pack, revision: pack.revision + 1, variants: [...pack.variants, variant] }, id }
}

export function renameLayout(pack: HudStylePack, variantId: string, id: string): { pack: HudStylePack; error: string | null } {
  const updated = { ...pack, revision: pack.revision + 1,
    variants: pack.variants.map(variant => variant.id === variantId ? { ...variant, id } : variant) }
  const issues = parseHudStylePack(updated).issues.filter(issue => /^variants\[\d+\]\.id$/u.test(issue.path))
  return issues.length ? { pack, error: issues.map(issue => issue.message).join('; ') } : { pack: updated, error: null }
}

export function removeLayout(pack: HudStylePack, variantId: string): HudStylePack {
  return pack.variants.length <= 1 ? pack : { ...pack, revision: pack.revision + 1,
    variants: pack.variants.filter(variant => variant.id !== variantId) }
}
