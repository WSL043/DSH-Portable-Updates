import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildCoreIndex } from '../scripts/build-core-index.mjs'

test('the reusable publisher checks out and tests its own catalog implementation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-core-channel.yml', import.meta.url), 'utf8')
  assert.match(workflow, /repository: WSL043\/DSH-Portable-Updates\s+ref: main\s+path: update-channel/)
  assert.match(workflow, /node --test update-channel\/tests\/\*\.test\.mjs/)
  assert.match(workflow, /node update-channel\/scripts\/build-core-index\.mjs/)
  assert.match(workflow, /publish\/dsh-core-index-\*\.json/)
  assert.match(workflow, /versions\[\]\.manifestUrl/)
})

function manifest(version, archive = version) {
  return {
    schemaVersion: 1,
    updateKind: 'engine',
    component: {
      dshVersion: version,
      urls: [`https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-candidate/core-${archive}.zip`],
    },
  }
}

test('the first catalog preserves the previous latest core beside the current version', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))

  const result = await buildCoreIndex({
    channel: 'candidate',
    platform: 'windows-x64',
    currentManifest: manifest('0.1.2-rc.1'),
    previousIndex: { schemaVersion: 1, versions: [] },
    previousLatestManifest: manifest('0.1.2-alpha.5'),
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), ['0.1.2-rc.1', '0.1.2-alpha.5'])
  assert.deepEqual(result.versionedManifestNames, [
    'dsh-core-update-windows-x64-0.1.2-rc.1.json',
    'dsh-core-update-windows-x64-0.1.2-alpha.5.json',
  ])
  for (const name of result.versionedManifestNames) {
    assert.equal(JSON.parse(await readFile(path.join(output, name), 'utf8')).updateKind, 'engine')
  }
})

test('catalog updates stay newest-first, unique, and bounded to five versions', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const previousVersions = ['0.1.2-beta.4', '0.1.2-beta.3', '0.1.2-beta.2', '0.1.2-beta.1', '0.1.2-alpha.9']
  const previousIndex = {
    schemaVersion: 1,
    versions: previousVersions.map(version => ({
      version,
      manifestUrl: `https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-candidate/dsh-core-update-linux-x64-${version}.json`,
      manifest: manifest(version),
    })),
  }

  const result = await buildCoreIndex({
    channel: 'candidate',
    platform: 'linux-x64',
    currentManifest: manifest('0.1.2-rc.1'),
    previousIndex,
    previousLatestManifest: manifest('0.1.2-beta.4'),
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), [
    '0.1.2-rc.1', '0.1.2-beta.4', '0.1.2-beta.3', '0.1.2-beta.2', '0.1.2-beta.1',
  ])
  assert.equal(new Set(result.index.versions.map(entry => entry.version)).size, 5)
})

test('invalid prior catalog entries cannot inject untrusted manifests', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const previousIndex = {
    schemaVersion: 1,
    versions: [{
      version: '0.1.2-alpha.5',
      manifestUrl: 'https://evil.invalid/core.json',
      manifest: manifest('0.1.2-alpha.5'),
    }],
  }

  const result = await buildCoreIndex({
    channel: 'candidate',
    platform: 'macos-arm64',
    currentManifest: manifest('0.1.2-rc.1'),
    previousIndex,
    previousLatestManifest: null,
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), ['0.1.2-rc.1'])
})
