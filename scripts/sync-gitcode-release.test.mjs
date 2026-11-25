import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { expectedReleasePackages } from './render-release-notes.mjs'
import { syncGitcodeRelease } from './sync-gitcode-release.mjs'

async function createArtifactDirectory(version) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-gitcode-test-'))
  const names = [...expectedReleasePackages(version), 'SHA256SUMS.txt']
  for (const name of names) {
    await writeFile(path.join(dir, name), `payload:${name}`)
  }
  return { dir, names }
}

test('syncGitcodeRelease skips cleanly when --if-configured is set without token', async () => {
  const result = await syncGitcodeRelease({
    version: '0.5.1',
    directory: os.tmpdir(),
    notes: '# Fy1Sync 0.5.1',
    token: '',
    ifConfigured: true,
    fetchImpl: async () => { throw new Error('must not call network') },
  })
  assert.deepEqual(result, { skipped: true, uploaded: [], reused: [] })
})

test('syncGitcodeRelease creates missing release and uploads all 13 artifacts', async () => {
  const { dir, names } = await createArtifactDirectory('0.5.1')
  try {
    const calls = []
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers })
      if (url.endsWith('/releases/tags/v0.5.1')) {
        return new Response('Not found', { status: 404 })
      }
      if (url.endsWith('/releases') && init.method === 'POST') {
        const body = JSON.parse(init.body)
        assert.equal(body.tag_name, 'v0.5.1')
        assert.equal(body.name, 'Fy1Sync 0.5.1')
        return Response.json({ id: 99, tag_name: 'v0.5.1', assets: [] })
      }
      if (url.includes('/upload_url?file_name=')) {
        const file = new URL(url).searchParams.get('file_name')
        return Response.json({
          url: `https://obs.gitcode.example.com/upload/${encodeURIComponent(file)}`,
          headers: { 'x-obs-acl': 'private' },
        })
      }
      if (url.startsWith('https://obs.gitcode.example.com/upload/') && init.method === 'PUT') {
        assert.equal(init.headers['x-obs-acl'], 'private')
        return new Response('', { status: 200 })
      }
      throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${url}`)
    }

    const outcome = await syncGitcodeRelease({
      version: '0.5.1',
      directory: dir,
      notes: '# Fy1Sync 0.5.1\n\nRelease body',
      token: 'test-token',
      fetchImpl,
    })
    assert.equal(outcome.skipped, false)
    assert.equal(outcome.uploaded.length, 13)
    assert.equal(outcome.reused.length, 0)
    assert.deepEqual(outcome.uploaded.sort(), names.sort())
    assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/releases')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('syncGitcodeRelease updates existing release and skips already-uploaded matching assets', async () => {
  const { dir, names } = await createArtifactDirectory('0.5.1')
  try {
    const existing = names.slice(0, 12).map(name => ({
      name,
      size: Buffer.byteLength(`payload:${name}`),
    }))
    const outcome = await syncGitcodeRelease({
      version: '0.5.1',
      directory: dir,
      notes: '# Updated',
      token: 'test-token',
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/releases/tags/v0.5.1')) {
          return Response.json({ id: 42, tag_name: 'v0.5.1', assets: existing })
        }
        if (url.endsWith('/releases/42') && init.method === 'PATCH') {
          return Response.json({ id: 42, tag_name: 'v0.5.1', assets: existing })
        }
        if (url.includes('/upload_url?file_name=')) {
          return Response.json({ url: 'https://obs.gitcode.example.com/put', headers: {} })
        }
        if (url === 'https://obs.gitcode.example.com/put' && init.method === 'PUT') {
          return new Response('', { status: 200 })
        }
        throw new Error(`Unexpected request: ${url}`)
      },
    })
    assert.equal(outcome.reused.length, 12)
    assert.deepEqual(outcome.uploaded, [names[12]])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('syncGitcodeRelease rejects insecure upload URLs and incomplete directories', async () => {
  const { dir, names } = await createArtifactDirectory('0.5.1')
  try {
    await assert.rejects(() => syncGitcodeRelease({
      version: '0.5.1',
      directory: dir,
      notes: '# Notes',
      token: 'test-token',
      fetchImpl: async url => {
        if (url.endsWith('/releases/tags/v0.5.1')) return Response.json({ id: 1, assets: [] })
        if (url.endsWith('/releases/1')) return Response.json({ id: 1, assets: [] })
        return Response.json({ url: 'http://obs.gitcode.example.com/insecure', headers: {} })
      },
    }), /HTTPS/)

    await rm(path.join(dir, names[0]))
    await assert.rejects(() => syncGitcodeRelease({
      version: '0.5.1',
      directory: dir,
      notes: '# Notes',
      token: 'test-token',
      fetchImpl: async () => Response.json({}),
    }), /13 release files/)

    await symlink(path.join(dir, names[1]), path.join(dir, names[0])).catch(() => {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
