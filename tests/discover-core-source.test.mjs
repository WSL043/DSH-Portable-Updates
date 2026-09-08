import test from 'node:test'
import assert from 'node:assert/strict'
import { selectCoreRelease } from '../scripts/discover-core-source.mjs'
import { readFile } from 'node:fs/promises'
const registry = { 'dist-tags': { latest: '0.1.2', alpha: '0.1.3-alpha.2', rc: '0.1.2-rc.2' }, versions: Object.fromEntries(['0.1.2','0.1.2-rc.1','0.1.2-rc.2','0.1.3-alpha.2'].map(v=>[v,{dist:{integrity:'sha512-'+v}}])) }
test('stable advances to a final release while candidate selects the newest prerelease', () => {
  const current={version:'0.1.2-rc.1',integrity:'sha512-0.1.2-rc.1'}
  assert.equal(selectCoreRelease(registry,'stable',current).version,'0.1.2')
  assert.equal(selectCoreRelease(registry,'candidate',current).version,'0.1.3-alpha.2')
})
test('retagging cannot downgrade an accepted core or widen stable to Alpha', () => {
  const moved={...registry,'dist-tags':{latest:'0.1.3-alpha.2',alpha:'0.1.2-rc.2'}}
  assert.equal(selectCoreRelease(moved,'stable',{version:'0.1.2',integrity:'sha512-0.1.2'}).version,'0.1.2')
  assert.equal(selectCoreRelease(moved,'candidate',{version:'0.1.3-alpha.2',npmIntegrity:'sha512-0.1.3-alpha.2'}).version,'0.1.3-alpha.2')
})
test('changed or missing integrity fails before staging', () => {
  assert.throws(()=>selectCoreRelease(registry,'stable',{version:'0.1.2',integrity:'wrong'}),/integrity changed/)
  assert.throws(()=>selectCoreRelease({...registry,versions:{}},'candidate',{version:'0.1.2-rc.1'}),/no integrity/)
})
test('source packing, platform builds and publication all consume the discovered lock', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-core-channel.yml', import.meta.url), 'utf8')
  assert.equal(workflow.split('run: cp resolved-core/lock.json "$LOCK_FILE"').length - 1, 3)
  assert.match(workflow, /publish: \$\{\{ steps.discovery.outputs.publish \}\}/)
  assert.match(workflow, /needs: \[resolve, build\]/)
  assert.match(workflow, /publish\/official-core.lock.json --clobber/)
})
