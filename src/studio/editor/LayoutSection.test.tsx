import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { LayoutSection } from './LayoutSection'

it('offers both lower resolution actions only for a 3840x2160 layout', () => {
  const pack = createEmptyHudStylePack('custom/layouts', '布局', { width: 3840, height: 2160 })
  const onGenerate = vi.fn()
  const props = { pack, variant: pack.variants[0]!, canCreate: false, onSelect: vi.fn(), onCreate: vi.fn(), onGenerate, onRename: () => null, onDelete: vi.fn() }
  const view = render(<LayoutSection {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '生成 1440p' }))
  fireEvent.click(screen.getByRole('button', { name: '生成 1080p' }))
  expect(onGenerate.mock.calls).toEqual([[1440], [1080]])
  view.rerender(<LayoutSection {...props} variant={{ ...props.variant, nativeSize: { width: 2560, height: 1440 } }} />)
  expect(screen.queryByRole('button', { name: '生成 1440p' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '生成 1080p' })).not.toBeInTheDocument()
})
