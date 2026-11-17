/** A memory bound for signed inputs, independent of any platform URL convention. */
export const MAX_MEDIA_INPUT_LENGTH = 256 * 1024

export function displayMediaInput(input: string): string {
  try {
    const url = new URL(input)
    if (!url.username && !url.password) return input
    url.username = ''; url.password = ''
    return url.href
  } catch { return input }
}
