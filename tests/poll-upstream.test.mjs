import assert from 'node:assert/strict'
import test from 'node:test'
import { pollOfficialDesktop, retryUnassignedCoreRunner } from '../scripts/poll-upstream.mjs'

const now = Date.parse('2026-11-18T13:40:00Z')
const recent = new Date(now - 30 * 60 * 1000).toISOString()
const delayed = new Date(now - 120 * 60 * 1000).toISOString()

async function poll({ nightly = '0.2.2-rc.5', publishedNightly = '0.2.2-rc.3', stable = nightly, publishedStable, runs = [] } = {}) {
  const calls = []
  const result = await pollOfficialDesktop({
    now,
    request: async url => {
      const version = url.endsWith('nightly.yml')
        ? (url.includes('download.deepseek.com') ? nightly : publishedNightly)
        : (url.includes('download.deepseek.com') ? stable : publishedStable)
      return version ? new Response('version: ' + version + '\n') : new Response(null, { status: 404 })
    },
    invoke: (cmd, args) => {
      assert.equal(cmd, 'gh')
      calls.push(args)
      return args[0] === 'run' ? JSON.stringify(runs) : 'https://github.com/WSL043/DSH-Portable/actions/runs/123'
    },
  })
  return { result, calls }
}

test('the scheduled Desktop fallback dispatches the existing publishing workflow if hosted cron is delayed', async () => {
  const { result, calls } = await poll({ runs: [{ status: 'completed', event: 'schedule', createdAt: delayed }] })
  assert.match(result, /nightly 0\.2\.2-rc\.5: scheduled poll dispatched/)
  assert.deepEqual(calls[1], ['workflow', 'run', 'official-desktop-channel.yml', '-R', 'WSL043/DSH-Portable', '--ref', 'main', '-f', 'publish_channel=true'])
})

test('the fallback respects the hosted schedule and avoids duplicate or rapid repeated qualification', async () => {
  for (const run of [
    { status: 'in_progress', event: 'schedule', createdAt: delayed },
    { status: 'completed', event: 'schedule', createdAt: recent },
    { status: 'completed', event: 'workflow_dispatch', createdAt: recent },
  ]) assert.equal((await poll({ runs: [run] })).calls.length, 1)
})

test('the poll ignores already published versions and waits for a final release on the stable channel', async () => {
  assert.deepEqual((await poll({ publishedNightly: '0.2.2-rc.5' })).calls, [])
  assert.deepEqual((await poll({ publishedNightly: '0.2.2-rc.6' })).calls, [])
  const result = await poll({ publishedNightly: '0.2.2-rc.5', stable: '0.2.2' })
  assert.match(result.result, /Desktop stable 0\.2\.2: scheduled poll dispatched/)
})

test('the timer retries the single unassigned core runner once and keeps the other four results', () => {
  const record = { status: 'failed', version: '0.2.2-rc.5', pipelineSha: 'pipeline', sourceSha: 'portable', attemptedAt: '2026-11-18T13:22:16.000Z' }
  const latest = { id: 10, conclusion: 'failure', run_attempt: 1, head_sha: 'pipeline', created_at: '2026-11-18T13:22:00Z', updated_at: '2026-11-18T13:43:57Z' }
  const cancelled = { id: 20, name: 'core / build (macos-15, macos, arm64, macos-arm64)', conclusion: 'cancelled', steps: [], runner_name: '', html_url: 'https://example.test/job/20' }
  const jobs = [cancelled, ...Array.from({ length: 4 }, (_, i) => ({ name: 'core / build (' + i + ')', conclusion: 'success' })), { name: 'core / publish', conclusion: 'skipped' }]
  const annotation = { annotation_level: 'failure', message: 'The job was not acquired by Runner of type hosted even after multiple attempts' }

  function call({ run = latest, runner = cancelled, assetTime = '2026-11-18T12:00:00Z', sourceSha = 'portable', annotations = [annotation] } = {}) {
    const writes = []
    const result = retryUnassignedCoreRunner(record, (_, args) => {
      if (args[1] === 'rerun') { writes.push(args); return '' }
      if (args[0] === 'release') return JSON.stringify({ assets: [{ updatedAt: assetTime }] })
      if (args[1].includes('/actions/workflows/')) return JSON.stringify({ workflow_runs: [run] })
      if (args[1].includes('/actions/runs/')) return JSON.stringify({ jobs: [runner, ...jobs.slice(1)] })
      if (args[1].includes('/check-runs/')) return JSON.stringify(annotations)
      if (args[1].endsWith('/releases/latest')) return JSON.stringify({ target_commitish: sourceSha })
      throw new Error('Unexpected request')
    })
    return { result, writes }
  }

  const recovered = call()
  assert.match(recovered.result, /scheduled poll retried unassigned runner/)
  assert.deepEqual(recovered.writes, [['run', 'rerun', '-R', 'WSL043/DSH-Portable-Updates', '--job', '20']])
  for (const options of [
    { run: { ...latest, run_attempt: 2 } },
    { run: { ...latest, head_sha: 'new-pipeline' } },
    { runner: { ...cancelled, runner_name: 'runner-1' } },
    { assetTime: '2026-11-18T13:34:00Z' },
    { sourceSha: 'changed-portable' },
    { annotations: [] },
  ]) assert.deepEqual(call(options), { result: null, writes: [] })
})
