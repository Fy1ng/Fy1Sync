import type { YouTubeBrowseManager } from './ytBrowse'
import type { YouTubeImportJobManager } from './ytImport'

export const YOUTUBE_ADMIN_METHODS = [
  'ytBrowseOpen', 'ytBrowseClose', 'ytBrowseCommand', 'ytBrowseState', 'ytBrowseSnapshot',
  'ytBrowseSetViewport', 'ytImportStart', 'ytImportCancel', 'ytImportList',
] as const

export type YtBrowseState = Awaited<ReturnType<YouTubeBrowseManager['state']>>
export type YtImportJob = ReturnType<YouTubeImportJobManager['list']>[number]
export interface YouTubeAdminMethods {
  ytBrowseOpen: { args: { url: string }; result: Awaited<ReturnType<YouTubeBrowseManager['open']>> }
  ytBrowseClose: { args: undefined; result: { ok: true } }
  ytBrowseCommand: { args: Parameters<YouTubeBrowseManager['command']>[0]; result: YtBrowseState }
  ytBrowseState: { args: undefined; result: YtBrowseState }
  ytBrowseSnapshot: { args: undefined; result: Awaited<ReturnType<YouTubeBrowseManager['snapshot']>> }
  ytBrowseSetViewport: { args: Parameters<YouTubeBrowseManager['setViewport']>[0]; result: { ok: true } }
  ytImportStart: { args: Parameters<YouTubeImportJobManager['start']>[0]; result: YtImportJob }
  ytImportCancel: { args: { jobId: string }; result: YtImportJob | null }
  ytImportList: { args: undefined; result: YtImportJob[] }
}
