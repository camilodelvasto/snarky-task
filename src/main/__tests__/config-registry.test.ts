import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from '../tasks/config'
import { loadRegistry } from '../tasks/registry'

function tasksDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'td-'))
  mkdirSync(join(dir, 'tasks'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'tasks', name), content)
  }
  return join(dir, 'tasks')
}

const GOOD_CONFIG = JSON.stringify({
  resolver: { impl: 'ollama', host: 'http://127.0.0.1:11434', model: 'm' },
  dates: { impl: 'chrono' },
  thresholds: { card: 0.6 },
  jobs: { max_parallel: 3 },
  confirmation_timeout_s: 300
})

describe('loadConfig', () => {
  it('loads a valid config', () => {
    const dir = tasksDir({ 'config.json': GOOD_CONFIG })
    expect(loadConfig(dir).resolver.impl).toBe('ollama')
  })
  it('throws when the file is missing', () => {
    const dir = tasksDir({})
    expect(() => loadConfig(dir)).toThrow(/config\.json/)
  })
  it('throws when a required field is missing — no silent defaults', () => {
    const bad = JSON.parse(GOOD_CONFIG)
    delete bad.thresholds
    const dir = tasksDir({ 'config.json': JSON.stringify(bad) })
    expect(() => loadConfig(dir)).toThrow(/thresholds/)
  })
})

describe('loadRegistry', () => {
  it('loads valid registry keys', () => {
    const dir = tasksDir({ 'registry.json': JSON.stringify({ create: { class: 'normal' } }) })
    expect(loadRegistry(dir).registry.create.class).toBe('normal')
  })
  it('throws on an unknown operation class', () => {
    const dir = tasksDir({ 'registry.json': JSON.stringify({ x: { class: 'spicy' } }) })
    expect(() => loadRegistry(dir)).toThrow(/spicy/)
  })
  it('returns aliases separately from registry', () => {
    const registryJson = {
      create: { class: 'normal' },
      aliases: {
        create: ['add', 'new'],
        move: ['mv']
      }
    }
    const dir = tasksDir({ 'registry.json': JSON.stringify(registryJson) })
    const { aliases } = loadRegistry(dir)
    expect(aliases).toEqual({
      create: ['add', 'new'],
      move: ['mv']
    })
  })
  it('strips aliases key from registry', () => {
    const registryJson = {
      create: { class: 'normal' },
      aliases: {
        create: ['add', 'new']
      }
    }
    const dir = tasksDir({ 'registry.json': JSON.stringify(registryJson) })
    const { registry } = loadRegistry(dir)
    expect((registry as Record<string, unknown>).aliases).toBeUndefined()
  })
  it('yields empty aliases object when registry has no aliases key', () => {
    const dir = tasksDir({ 'registry.json': JSON.stringify({ create: { class: 'normal' } }) })
    const { aliases } = loadRegistry(dir)
    expect(aliases).toEqual({})
  })
  it('accepts declared target policies', () => {
    const dir = tasksDir({
      'registry.json': JSON.stringify({
        create: { class: 'normal', target: 'none' },
        delegate: { class: 'normal', target: 'create' },
        update_status: { class: 'normal', target: 'resolve' },
        note: { class: 'normal', target: 'required' }
      })
    })
    const { registry } = loadRegistry(dir)
    expect(registry.delegate.target).toBe('create')
  })
  it('throws at startup on an unknown target policy (no-fallbacks)', () => {
    const dir = tasksDir({
      'registry.json': JSON.stringify({ delegate: { class: 'normal', target: 'banana' } })
    })
    expect(() => loadRegistry(dir)).toThrow(/unknown target "banana"/)
  })
})
