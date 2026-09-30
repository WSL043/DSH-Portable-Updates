import assert from 'node:assert/strict'
import test from 'node:test'
import { selectNativeRelease } from '../scripts/select-native-release.mjs'

const native = (tag_name, published_at, prerelease = false) => ({ tag_name, published_at, prerelease, draft: false,
  assets: ['portable-manifest.json', 'DSH-Portable-windows-x64-offline.zip', 'checksums.txt'].map(name => ({ name })) })
const stable = native('v0.7.5', '2026-09-26T19:35:31Z')
const old = native('v0.7.4', '2026-09-23T04:55:50Z')
const alpha = native('v0.7.6-alpha.1', '2026-09-27T19:35:31Z', true)
const electron = { ...native('v1.0.0-alpha.1', '2026-09-28T19:35:31Z', true), assets: [
  { name: 'DSH-Portable-1.0.0-alpha.1-electron-windows-x64.zip' }, { name: 'checksums.txt' },
] }

test('only published stable Native releases can be the single qualification baseline', () => {
  assert.equal(selectNativeRelease([old, alpha, stable, electron]), stable)
  const nextMajorStable = native('v2.0.0', '2026-10-01T00:00:00Z')
  assert.equal(selectNativeRelease([stable, nextMajorStable]), nextMajorStable)
})

for (const field of ['draft', 'assets', 'published_at', 'tag_name']) test(`invalid ${field} cannot become a baseline`, () => {
  const invalid = { ...stable, [field]: { draft: true, assets: stable.assets.slice(0, 2), published_at: null, tag_name: 'update-channel-candidate' }[field] }
  assert.equal(selectNativeRelease([invalid, stable]), stable)
})

test('absence of a published stable Native Portable fails closed', () => {
  assert.throws(() => selectNativeRelease([electron, alpha]), /No published Native Portable stable/)
  assert.throws(() => selectNativeRelease([]), /No published Native Portable stable/)
})
