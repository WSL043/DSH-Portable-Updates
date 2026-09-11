import test from 'node:test'
import assert from 'node:assert/strict'
import { selectCoreRelease } from '../scripts/discover-core-source.mjs'

const registry = { versions: Object.fromEntries(['0.1.5-rc.1', '0.1.5-rc.2', '0.1.4-rc.1'].map(version =>
  [version, { dist: { integrity: `sha512-${version}` } }])) }
const current = { version: '0.1.5-rc.2', integrity: 'sha512-0.1.5-rc.2' }
const state = [
  { sourceSha: 'old', version: '0.1.5-rc.1', status: 'success' },
  { sourceSha: 'new', version: '0.1.5-rc.2', status: 'success' },
]
for (const channel of ['stable', 'candidate']) test(`${channel}: old success queues fresh qualification without admitting unknown history`, () => {
  assert.equal(selectCoreRelease(registry, channel, current, false, { sourceSha: 'new', state }).version, '0.1.5-rc.1')
  assert.equal(selectCoreRelease(registry, channel, current, true, { sourceSha: 'new', state }).version, null)
  const done = [...state, { sourceSha: 'new', version: '0.1.5-rc.1', status: 'success' }]
  assert.equal(selectCoreRelease(registry, channel, current, false, { sourceSha: 'new', state: done }).version, null)
})
test('historical failures keep their retry cooldown and deprecated history is excluded', () => {
  const failed = [...state, { sourceSha: 'new', version: '0.1.5-rc.1', status: 'failed', retryAfter: '2099-01-01T00:00:00Z' }]
  assert.equal(selectCoreRelease(registry, 'candidate', current, false, { sourceSha: 'new', state: failed }).version, null)
  const deprecated = structuredClone(registry)
  deprecated.versions['0.1.5-rc.1'].deprecated = 'known defect'
  assert.equal(selectCoreRelease(deprecated, 'candidate', current, false, { sourceSha: 'new', state }).version, null)
})
