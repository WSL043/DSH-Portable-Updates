import test from 'node:test'
import assert from 'node:assert/strict'
import { ADAPTERS, preflightAdapters, checkDefaultPluginCapabilities, checkDefaultPluginPeers, fetchPinnedDefaultPluginManifests } from '../scripts/preflight-adapters.mjs'
import { selectCoreRelease } from '../scripts/discover-core-source.mjs'
import { updateQualificationState } from '../scripts/update-qualification-state.mjs'

test('the shipped native-slot chat client cannot qualify a host without that slot', () => {
  const lock = { defaultPlugins: { chatManager: { version: '1.5.0' } } }
  assert.equal(checkDefaultPluginCapabilities(lock, 'legacy workspace').status, 'blocked')
  assert.equal(checkDefaultPluginCapabilities(lock, '"sidebar.workspaces.session.menu.item": {}').status, 'success')
  assert.equal(checkDefaultPluginCapabilities({defaultPlugins:{chatManager:{version:'1.3.5'}}}, 'legacy workspace').status, 'success')
})

test('core intake blocks a candidate whose published default plugins exclude that DSH version', async () => {
  const lock = { defaultPlugins: { chatManager: { package: 'dsh-chat-manager', version: '1.5.1' } } }
  const plugin = { name: 'dsh-chat-manager', version: '1.5.1', peerDependencies: {
    '@deepseek-ai/dsh-client-ui-conversation': '0.1.7-alpha.1',
  } }
  const manifests = await fetchPinnedDefaultPluginManifests(lock, async () => ({ ok: true, json: async () => plugin }))
  const satisfies = (version, range) => version === range
  assert.equal(checkDefaultPluginPeers(lock, manifests, '0.1.7-alpha.2', satisfies).status, 'blocked')
  assert.equal(checkDefaultPluginPeers(lock, manifests, '0.1.7-alpha.1', satisfies).status, 'success')
  assert.equal(checkDefaultPluginPeers(lock, { 'dsh-chat-manager': { ...plugin, version: 'wrong' } }, '0.1.7-alpha.1', satisfies).status, 'failed')
})

test('preflight stops on structural failure before remaining adapters', () => {
  let calls = 0
  const result = preflightAdapters('.', 'app', () => {
    calls++
    return { status: 1, stderr: 'Error: native settings command seam changed upstream: expected 1 match, found 0' }
  })
  assert.equal(result.status, 'blocked')
  assert.equal(calls, 1)
  assert.match(result.detail, /seam changed upstream/)
})

test('ordinary errors remain retryable and successful preflight visits every adapter', () => {
  for (const result of [{status:1,stderr:'ENOENT'}, {status:null,error:new Error('timeout')}]) {
    assert.equal(preflightAdapters('.', 'app', () => result).status, 'failed')
  }
  let count = 0
  assert.equal(preflightAdapters('.', 'app', () => { count++; return {status:0} }).status, 'success')
  assert.equal(count, ADAPTERS.length)
})

test('blocked combination stays blocked beyond cooldown but a new baseline or pipeline retries', () => {
  const version = '0.1.7-alpha.1'
  const current = {version, integrity:'sha512-test'}
  const registry = {versions:{[version]:{dist:{integrity:current.integrity}}}}
  const state = updateQualificationState([], {sourceSha:'old', pipelineSha:'pipeline', version,
    status:'blocked', attemptedAt:'2026-09-22T00:00:00Z'})
  assert.equal(state[0].retryAfter, null)
  const choose = options => selectCoreRelease(registry, 'candidate', current, false,
    {sourceSha:'old',pipelineSha:'pipeline',state,now:Date.parse('2030-01-01'),...options})
  assert.equal(choose({}).version, null)
  assert.equal(choose({sourceSha:'new'}).version, version)
  assert.equal(choose({pipelineSha:'fixed'}).version, version)
  assert.equal(choose({rebuild:true}).version, version)
})
