/** In-page routing keeps the document, so the session and its elements survive. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { navigate, routeLink } from './navigate'

afterEach(() => window.history.replaceState(null, '', '/'))

describe('navigate', () => {
  it('pushes the path and announces it, without loading a document', () => {
    const heard = vi.fn()
    window.addEventListener('popstate', heard)
    navigate('/admin')
    window.removeEventListener('popstate', heard)
    expect(window.location.pathname).toBe('/admin')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('does nothing when already there', () => {
    const push = vi.spyOn(window.history, 'pushState')
    navigate('/')
    expect(push).not.toHaveBeenCalled()
    push.mockRestore()
  })
})

describe('routeLink', () => {
  const click = (init: Partial<React.MouseEvent<HTMLAnchorElement>> = {}) => {
    const event = { defaultPrevented: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      preventDefault: vi.fn(), ...init }
    return event as unknown as React.MouseEvent<HTMLAnchorElement> & { preventDefault: ReturnType<typeof vi.fn> }
  }

  it('takes over a plain click and runs the hook first', () => {
    const before = vi.fn()
    const link = routeLink('/admin', before)
    const event = click()
    link.onClick(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(before).toHaveBeenCalled()
    expect(window.location.pathname).toBe('/admin')
    expect(link.href).toBe('/admin')
  })

  it('leaves modified and non-primary clicks to the browser', () => {
    const link = routeLink('/admin')
    for (const init of [{ ctrlKey: true }, { button: 1 }, { shiftKey: true }]) {
      const event = click(init)
      link.onClick(event)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(window.location.pathname).toBe('/')
  })
})
