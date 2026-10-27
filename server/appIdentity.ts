/** Public contact for metadata providers. Keep the mailbox in one place. */
export const CONTACT_EMAIL = 'sync@fy1ng.cn'
export const metadataUserAgent = (version: string): string => `Fy1Sync/${version} (local desktop app; ${CONTACT_EMAIL})`
