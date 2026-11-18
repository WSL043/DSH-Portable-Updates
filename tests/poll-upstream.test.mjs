import assert from 'node:assert/strict'
import test from 'node:test'
import { pollOfficialDesktop } from '../scripts/poll-upstream.mjs'

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
