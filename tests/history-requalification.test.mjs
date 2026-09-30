import test from 'node:test'
import assert from 'node:assert/strict'
import { selectCoreRelease } from '../scripts/discover-core-source.mjs'
import { mergeQualificationStates } from '../scripts/update-qualification-state.mjs'

const topThree = ['0.2.0-rc.2', '0.2.0-rc.1', '0.1.7-rc.2']
const registry = { versions: Object.fromEntries(topThree.map(version => [version, { dist: { integrity: `sha512-${version}` } }])) }
const current = { version: '0.1.7-rc.2', npmIntegrity: 'sha512-0.1.7-rc.2' }

test('legacy qualification state migrates once into one top-three window without importing out-of-window history', () => {
  const canonical = [{ sourceSha: 'shell', version: topThree[0], status: 'failed', attemptedAt: '2026-09-28T00:00:00Z', retryAfter: '2026-09-29T00:00:00Z' }]
  const stable = [
    { sourceSha: 'shell', version: topThree[0], status: 'success', attemptedAt: '2026-09-29T00:00:00Z' },
    { sourceSha: 'same-shell', version: '0.1.5-rc.1', status: 'success', attemptedAt: '2026-09-30T00:00:00Z' },
  ]
  const candidate = [{ sourceSha: 'candidate-shell', version: topThree[1], status: 'failed', attemptedAt: '2026-09-27T00:00:00Z' }]
  const migrated = mergeQualificationStates(topThree, canonical, stable, candidate)
  assert.deepEqual(migrated.map(({ sourceSha, version, status }) => ({ sourceSha, version, status })), [
    { sourceSha: 'shell', version: topThree[0], status: 'success' },
    { sourceSha: 'candidate-shell', version: topThree[1], status: 'failed' },
  ])
})

test('a previously successful core for another shell is not qualification proof for this shell', () => {
  const state = mergeQualificationStates(topThree, [{ sourceSha: 'old-shell', version: topThree[0], status: 'success' }])
  const selected = selectCoreRelease(registry, current, false, { sourceSha: 'new-shell', state })
  assert.equal(selected.version, topThree[0])
})

test('failed top-three cores retain the 24-hour cooldown and dispatch queue is capped at two fallbacks', async () => {
  const failed = topThree.map(version => ({ sourceSha: 'shell', version, status: 'failed',
    pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' }))
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: failed }).version, null)
  const workflow = await (await import('node:fs/promises')).readFile(new URL('../.github/workflows/sync-core.yml', import.meta.url), 'utf8')
  assert.match(workflow, /remaining:[\s\S]*default: 2/)
  assert.match(workflow, /\[1-2\]/)
  assert.doesNotMatch(workflow, /stable:\s+uses:|candidate:\s+uses:/)
})
