import assert from 'node:assert/strict'
import test from 'node:test'
import { selectNativeRelease } from '../scripts/select-native-release.mjs'

const native = (tag_name, published_at, prerelease = true) => ({ tag_name, published_at, prerelease, draft: false,
  assets: ['portable-manifest.json', 'DSH-Portable-windows-x64-offline.zip', 'checksums.txt'].map(name => ({ name })) })
const alpha = native('v0.7.5-alpha.1', '2026-09-23T10:39:49Z')
const electron = { ...native('v1.0.0-alpha.1', '2026-09-25T19:44:26Z'), assets: [{ name: 'DSH-Portable-1.0.0-alpha.1-electron-windows-x64.zip' }, { name: 'checksums.txt' }] }

test('a newer Electron preview never replaces the published Native candidate baseline', () => {
  assert.equal(selectNativeRelease([electron, alpha], 'candidate'), alpha)
})
test('stable and candidate baselines are independent and selected by publication time', () => {
  const stable = native('v0.7.5', '2026-09-26T19:35:31Z', false)
  const old = native('v0.7.4', '2026-09-23T04:55:50Z', false)
  assert.equal(selectNativeRelease([old, alpha, stable, electron], 'stable'), stable)
  assert.equal(selectNativeRelease([old, alpha, stable, electron], 'candidate'), alpha)
})
test('Native product identity is independent of a major-version assumption', () => {
  const next = native('v2.0.0-alpha.1', '2026-10-01T00:00:00Z')
  assert.equal(selectNativeRelease([alpha, next], 'candidate'), next)
})
for (const field of ['draft', 'assets', 'published_at', 'tag_name']) test(`invalid ${field} cannot become a baseline`, () => {
  const invalid = { ...native('v0.7.6-alpha.1', '2026-09-27T00:00:00Z'), [field]: { draft: true, assets: alpha.assets.slice(0, 2), published_at: null, tag_name: 'update-channel-candidate' }[field] }
  assert.equal(selectNativeRelease([invalid, alpha], 'candidate'), alpha)
})
test('absence fails explicitly instead of falling back to an unrelated architecture', () => {
  assert.throws(() => selectNativeRelease([electron], 'candidate'), /No published Native Portable/)
  assert.throws(() => selectNativeRelease([], 'other'), /Unsupported shell channel/)
})
