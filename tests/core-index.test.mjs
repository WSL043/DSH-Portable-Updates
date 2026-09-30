import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildCoreIndex, compareVersions } from '../scripts/build-core-index.mjs'

function manifest(version, archive = version, platform = 'windows-x64', {
  portableVersion = '0.7.6',
  requiredShellSchema = 25,
  requiredShellFingerprint = 'shell-fingerprint',
  targetRuntimeLayout = 'capsule-v1',
  requiredNodeVersion = '24.19.0',
  runtimeLayout = 'capsule-v1',
  channel = 'stable',
  releaseChannel = channel,
} = {}) {
  return {
    schemaVersion: 1,
    updateKind: 'engine',
    releaseChannel,
    portableVersion,
    requiredShellSchema,
    requiredShellFingerprint,
    targetRuntimeLayout,
    platform,
    component: {
      dshVersion: version,
      requiredNodeVersion,
      runtimeLayout,
      urls: [`https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-${channel}/DSH-Portable-update-${platform}-${version}-${archive}.zip`],
    },
  }
}

function entry(version, platform, channel = 'candidate', options = {}) {
  const value = manifest(version, version, platform, { ...options, channel })
  return { version, manifestUrl: `https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-${channel}/dsh-core-update-${platform}-${version}.json`, manifest: value }
}

async function makeIndex(options) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-index-'))
  return { ...(await buildCoreIndex({ ...options, output })), output }
}

test('publisher tests this checkout and publishes one five-platform qualification to both legacy tags', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-core-channel.yml', import.meta.url), 'utf8')
  const queue = await readFile(new URL('../.github/workflows/sync-core.yml', import.meta.url), 'utf8')
  assert.match(workflow, /repository: WSL043\/DSH-Portable-Updates\s+ref: main\s+path: update-channel/)
  assert.match(workflow, /node --test update-channel\/tests\/\*\.test\.mjs/)
  assert.match(workflow, /node update-channel\/scripts\/build-core-index\.mjs/)
  assert.match(workflow, /for channel in stable candidate/)
  assert.match(workflow, /\.releaseChannel = "stable"/)
  assert.match(workflow, /qualification-state\.json/)
  assert.match(queue, /remaining:[\s\S]*default: 2/)
  assert.doesNotMatch(workflow + queue, /shell_channel|inputs\.channel|needs\.stable|needs\.candidate/)
})

test('stable and candidate old clients accept per-tag index envelopes and one canonical stable manifest envelope', async t => {
  const topThree = ['0.2.0-rc.2', '0.2.0-rc.1', '0.1.7-rc.2']
  const previousIndexes = [{ schemaVersion: 1, versions: [
    entry('0.2.0-rc.1', 'windows-x64', 'candidate', { releaseChannel: 'candidate' }),
    entry('0.1.7-rc.2', 'windows-x64', 'stable'),
  ] }]
  const current = manifest('0.2.0-rc.2', 'current', 'windows-x64', { channel: 'stable' })
  const stable = await makeIndex({ channel: 'stable', platform: 'windows-x64', currentManifest: current,
    topThree, qualifiedVersions: topThree, previousIndexes, output: path.join(os.tmpdir(), `unused-${Date.now()}`) })
  const candidate = await makeIndex({ channel: 'candidate', platform: 'windows-x64', currentManifest: current,
    topThree, qualifiedVersions: topThree, previousIndexes, output: path.join(os.tmpdir(), `unused-${Date.now()}-candidate`) })
  t.after(() => Promise.all([rm(stable.output, { recursive: true, force: true }), rm(candidate.output, { recursive: true, force: true })]))

  assert.deepEqual(stable.index.versions.map(item => item.version), topThree)
  assert.deepEqual(candidate.index.versions.map(item => item.version), topThree)
  assert.equal(stable.index.releaseChannel, 'stable')
  assert.equal(candidate.index.releaseChannel, 'candidate')
  for (const [channel, result] of [['stable', stable], ['candidate', candidate]]) {
    for (const item of result.index.versions) {
      assert.match(item.manifestUrl, new RegExp(`/update-channel-core-${channel}/`))
      assert.equal(item.manifest.releaseChannel, 'stable')
      assert.ok(item.manifest.component.urls.every(url => url.includes(`/update-channel-core-${channel}/`)))
    }
  }

  // Contract fixture mirrors v0.8.2 Desktop Bridge index-channel validation
  // and update-core.evaluateUpdate: stable rejects candidate manifests while candidate accepts stable.
  const oldClientAccepts = (installedChannel, index, manifestValue) => index.releaseChannel === installedChannel
    && (installedChannel !== 'stable' || manifestValue.releaseChannel === 'stable')
  assert.ok(stable.index.versions.every(item => oldClientAccepts('stable', stable.index, item.manifest)))
  assert.ok(candidate.index.versions.every(item => oldClientAccepts('candidate', candidate.index, item.manifest)))
  for (const result of [stable, candidate]) {
    const alias = JSON.parse(await readFile(path.join(result.output, 'dsh-core-update-windows-x64.json'), 'utf8'))
    assert.equal(alias.component.dshVersion, topThree[0])
    assert.equal(alias.releaseChannel, 'stable')
  }
})

test('only qualified versions within the authoritative top-three window survive catalog generation', async t => {
  const topThree = ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1']
  const previousIndex = { schemaVersion: 1, versions: [
    entry('0.2.0-rc.2', 'linux-x64'),
    entry('0.2.0-rc.1', 'linux-x64'),
    entry('0.1.7-rc.2', 'linux-x64'),
  ] }
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-core-window-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const staleManifest = path.join(output, 'dsh-core-update-linux-x64-0.1.7-rc.2.json')
  await writeFile(staleManifest, '{"stale":true}\n')
  const result = await buildCoreIndex({ channel: 'stable', platform: 'linux-x64',
    currentManifest: manifest('0.2.0', 'new', 'linux-x64'),
    previousIndex, topThree, qualifiedVersions: ['0.2.0', '0.2.0-rc.2'], output })
  assert.deepEqual(result.index.versions.map(item => item.version), ['0.2.0', '0.2.0-rc.2'])
  assert.equal(result.versionedManifestNames.length, 2)
  await assert.rejects(readFile(staleManifest, 'utf8'), error => error.code === 'ENOENT')
  await assert.rejects(buildCoreIndex({ channel: 'stable', platform: 'linux-x64',
    currentManifest: manifest('0.1.7-rc.2', 'outside', 'linux-x64'), topThree,
    qualifiedVersions: topThree, output }), /not qualified inside the official SemVer window/)
})

test('SemVer ordering is prerelease-aware across mixed identifiers and final releases', () => {
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.1') > 0)
  assert.ok(compareVersions('0.2.0', '0.2.0-rc.999') > 0)
  assert.ok(compareVersions('0.2.0-beta.1', '0.2.0-rc.1') < 0)
  assert.ok(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2') > 0)
})
