import { describe, expect, it } from 'vitest'
import { DegradeController } from './degrade'

describe('camera load adaptation', () => {
  it('steps down after sustained overload and a full high-ratio window', () => {
    const controller = new DegradeController('quality')
    for (let i = 0; i < 59; i++) expect(controller.observe(20, 1000 / 60)).toBeNull()
    expect(controller.observe(20, 1000 / 60)).toBe('performance')
    for (let i = 0; i < 59; i++) expect(controller.observe(20, 1000 / 60)).toBeNull()
    expect(controller.observe(20, 1000 / 60)).toBe('off')
  })

  it('does not mistake isolated spikes or a short burst for sustained load', () => {
    const controller = new DegradeController('quality')
    for (let i = 0; i < 120; i++) expect(controller.observe(i % 10 === 0 ? 100 : 1, 16)).toBeNull()
    for (let i = 0; i < 30; i++) expect(controller.observe(30, 16)).toBeNull()
    expect(controller.tier).toBe('quality')
  })

  it('never upgrades and ignores invalid measurements', () => {
    const controller = new DegradeController('performance')
    expect(controller.observe(Number.NaN, 16)).toBeNull()
    expect(controller.observe(100, 0)).toBeNull()
    for (let i = 0; i < 60; i++) controller.observe(20, 16)
    expect(controller.tier).toBe('off')
    for (let i = 0; i < 1000; i++) expect(controller.observe(0.1, 16)).toBeNull()
    expect(controller.tier).toBe('off')
  })

  it('compares against the actual source interval', () => {
    const controller = new DegradeController('quality')
    for (let i = 0; i < 120; i++) expect(controller.observe(20, 1000 / 30)).toBeNull()
    expect(controller.tier).toBe('quality')
  })
})
