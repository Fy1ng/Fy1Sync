import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { BilibiliMessage, fillBilibiliMessage } from './BilibiliMessage'

it('renders mixed text and images and falls back to text when an image fails', () => {
  render(<BilibiliMessage text="你好[笑]！" emotes={[{ text: '[笑]', url: 'https://i0.hdslb.com/bfs/emote/test.png' }]} />)
  const image = screen.getByRole('img', { name: '[笑]' })
  expect(image.getAttribute('src')).toMatch(/^app:\/\/app\/bilibili-emote\?url=/)
  fireEvent.error(image)
  expect(screen.queryByRole('img')).toBeNull()
  expect(document.body.textContent).toContain('你好[笑]！')
})
it('builds the same emote nodes in the scrolling overlay without interpreting HTML', () => {
  const node = document.createElement('span')
  fillBilibiliMessage(node, '<script>[笑]', { emotes: [{ text: '[笑]', url: 'https://i0.hdslb.com/bfs/emote/test.png' }] })
  expect(node.querySelector('script')).toBeNull()
  expect(node.querySelector('img')?.alt).toBe('[笑]')
  node.querySelector('img')!.dispatchEvent(new Event('error'))
  expect(node.textContent).toBe('<script>[笑]')
})
