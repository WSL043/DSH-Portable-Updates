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
  assert.match(workflow, /releases\/latest/)
  assert.match(workflow, /CURRENT_IS_HIGHEST|TOP_VERSION/)
  assert.match(workflow, /publish\/official-core-\$\{SELECTED_VERSION\}\.lock\.json/)
  assert.match(workflow, /qualification-state:/)
})

function manifest(version, archive = version, platform = 'windows-x64', {
  portableVersion = '0.6.0-alpha.1',
  requiredShellSchema = 25,
  requiredShellFingerprint = 'shell-fingerprint',
  targetRuntimeLayout = 'capsule-v1',
  requiredNodeVersion = '24.19.0',
  runtimeLayout = 'capsule-v1',
} = {}) {
  return {
    schemaVersion: 1,
    updateKind: 'engine',
    portableVersion,
    requiredShellSchema,
    requiredShellFingerprint,
    targetRuntimeLayout,
    platform,
    component: {
      dshVersion: version,
      requiredNodeVersion,
      runtimeLayout,
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

test('the current manifest wins when a prior catalog repeats its DSH version', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const currentManifest = manifest('0.1.2-rc.1', 'current')
  const previousManifest = manifest('0.1.2-rc.1', 'previous')
  const previousIndex = {
    schemaVersion: 1,
    versions: [{
      version: '0.1.2-rc.1',
      manifestUrl: 'https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-candidate/dsh-core-update-windows-x64-0.1.2-rc.1.json',
      manifest: previousManifest,
    }],
  }

  const result = await buildCoreIndex({
    channel: 'candidate',
    platform: 'windows-x64',
    currentManifest,
    previousIndex,
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), ['0.1.2-rc.1'])
  assert.deepEqual(result.index.versions[0].manifest, currentManifest)
})

test('catalog retains older DSH versions with matching Portable compatibility', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const currentManifest = manifest('0.1.2-rc.1', 'current', 'linux-x64')
  const previousManifest = manifest('0.1.2-beta.4', 'previous', 'linux-x64')
  const previousIndex = {
    schemaVersion: 1,
    versions: [{
      version: '0.1.2-beta.4',
      manifestUrl: 'https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-candidate/dsh-core-update-linux-x64-0.1.2-beta.4.json',
      manifest: previousManifest,
    }],
  }

  const result = await buildCoreIndex({
    channel: 'candidate',
    platform: 'linux-x64',
    currentManifest,
    previousIndex,
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), ['0.1.2-rc.1', '0.1.2-beta.4'])
  assert.deepEqual(result.index.versions[1].manifest, previousManifest)
})

test('catalog removes prior DSH versions with incompatible Portable requirements', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const currentManifest = manifest('0.1.2-rc.1', 'current', 'macos-arm64')
  const previousManifest = manifest('0.1.2-beta.4', 'incompatible', 'macos-arm64', {
    requiredShellFingerprint: 'different-shell-fingerprint',
  })
  const previousIndex = {
    schemaVersion: 1,
    versions: [{
      version: '0.1.2-beta.4',
      manifestUrl: 'https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-candidate/dsh-core-update-macos-arm64-0.1.2-beta.4.json',
      manifest: previousManifest,
    }],
  }

  const result = await buildCoreIndex({
    channel: 'candidate',
    platform: 'macos-arm64',
    currentManifest,
    previousIndex,
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), ['0.1.2-rc.1'])
})

test('catalog updates stay newest-first, unique, and bounded to twenty versions', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const previousVersions = Array.from({length:24}, (_, index) => `0.1.2-beta.${24 - index}`)
  const previousIndex = {
    schemaVersion: 1,
    versions: previousVersions.map(version => ({
      version,
      manifestUrl: `https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-candidate/dsh-core-update-linux-x64-${version}.json`,
      manifest: manifest(version, version, 'linux-x64'),
    })),
  }

  const result = await buildCoreIndex({
    channel: 'candidate',
    platform: 'linux-x64',
    currentManifest: manifest('0.1.2-rc.1', '0.1.2-rc.1', 'linux-x64'),
    previousIndex,
    previousLatestManifest: manifest('0.1.2-beta.4', '0.1.2-beta.4', 'linux-x64'),
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), [
    '0.1.2-rc.1', ...previousVersions.slice(0, 19),
  ])
  assert.equal(new Set(result.index.versions.map(entry => entry.version)).size, 20)
})

test('historical backfill keeps a higher accepted version at the catalog head', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const currentManifest = manifest('0.1.2-alpha.1', 'current', 'linux-x64')
  const previousManifest = manifest('0.1.2-rc.1', 'previous', 'linux-x64')
  const previousIndex = {
    schemaVersion: 1,
    versions: [{
      version: '0.1.2-rc.1',
      manifestUrl: 'https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-candidate/dsh-core-update-linux-x64-0.1.2-rc.1.json',
      manifest: previousManifest,
    }],
  }
  const result = await buildCoreIndex({
    channel:'candidate', platform:'linux-x64', currentManifest, previousIndex,
    previousLatestManifest:previousManifest, output,
  })
  assert.deepEqual(result.index.versions.map(entry => entry.version), ['0.1.2-rc.1', '0.1.2-alpha.1'])
  assert.equal(result.index.versions[0].manifest, previousManifest)
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
    currentManifest: manifest('0.1.2-rc.1', '0.1.2-rc.1', 'macos-arm64'),
    previousIndex,
    previousLatestManifest: null,
    output,
  })

  assert.deepEqual(result.index.versions.map(entry => entry.version), ['0.1.2-rc.1'])
})
