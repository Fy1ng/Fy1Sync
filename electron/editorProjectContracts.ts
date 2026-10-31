import type { HudStylePack } from '../src/core/hudStylePack'

interface EditorMediaInfo {
  id: string
  name: string
  match: string
  purpose: 'making' | 'validation'
}
export interface EditorLocalMedia extends EditorMediaInfo {
  kind: 'local'
  path: string
  size: number
  sha256: string
}
export interface EditorYouTubeMedia extends EditorMediaInfo { kind: 'youtube'; assetId: string }
export type EditorMedia = EditorLocalMedia | EditorYouTubeMedia
export interface EditorProject {
  version: 1
  pack: HudStylePack
  variantId: string
  media: EditorMedia[]
  currentMediaId: string | null
}
export interface EditorMediaLocation { id: string; url: string }
export interface EditorProjectLoaded {
  project: EditorProject | null
  media: EditorMediaLocation | null
  needsRelink: boolean
}
export const EDITOR_PROJECT_METHODS = ['editorProjectLoad', 'editorProjectSave', 'editorMediaChoose', 'editorMediaRestore'] as const
export interface EditorProjectMethods {
  editorProjectLoad: { args: undefined; result: EditorProjectLoaded }
  editorProjectSave: { args: { project: EditorProject }; result: { ok: true } }
  editorMediaChoose: { args: { relinkId?: string }; result: { media: EditorLocalMedia; url: string } | null }
  editorMediaRestore: { args: { id: string }; result: { media: EditorMediaLocation | null; needsRelink: boolean } }
}
