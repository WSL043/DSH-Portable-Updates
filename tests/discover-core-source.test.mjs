import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverCoreSource, selectCoreRelease } from '../scripts/discover-core-source.mjs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

test('accepted-only refresh retains integrity checks without selecting newer upstream tags', () => {
  const current = {version:'0.1.2-rc.1',npmIntegrity:'sha512-0.1.2-rc.1'}
  assert.equal(selectCoreRelease(registry,'candidate',current,true).version,current.version)
  assert.throws(()=>selectCoreRelease(registry,'candidate',{...current,npmIntegrity:'changed'},true),/integrity changed/)
})

test('accepted-only refresh preserves the published immutable core when newer source is incompatible', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'core-accepted-refresh-'))
  const published={version:'0.1.3-alpha.2',npmIntegrity:'sha512-0.1.3-alpha.2',reviewedCommit:'b'.repeat(40),packedFamilies:{dsh:251,vendor:9,landlock:1}}
  const original=JSON.stringify({dsh:{version:'0.1.2-rc.1',npmIntegrity:'sha512-0.1.2-rc.1'},defaultPlugins:{keep:'current-shell'}})
  await writeFile(path.join(root,'upstream.preview.lock.json'),original)
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.includes('registry.npmjs.org'))return Response.json({...registry,'dist-tags':{alpha:'0.1.5-alpha.1'}})
    if(url.endsWith('official-core.lock.json'))return Response.json({dsh:published})
    throw Error('Accepted-only must not fetch new upstream source: '+url)
  })
  const output=path.join(root,'resolved/lock.json')
  const result=await discoverCoreSource({portableRoot:root,channel:'candidate',output,acceptedOnly:true})
  const lock=JSON.parse(await readFile(output,'utf8'))
  assert.equal(result.acceptedOnly,true)
  assert.deepEqual(lock.dsh,published)
  assert.deepEqual(lock.defaultPlugins,{keep:'current-shell'})
  assert.equal(await readFile(path.join(root,'upstream.preview.lock.json'),'utf8'),original)
})
test('source packing, platform builds and publication all consume the discovered lock', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-core-channel.yml', import.meta.url), 'utf8')
  assert.equal(workflow.split('run: cp resolved-core/lock.json "$LOCK_FILE"').length - 1, 3)
  assert.match(workflow, /publish: \$\{\{ steps.discovery.outputs.publish \}\}/)
  assert.match(workflow, /needs: \[resolve, build\]/)
  assert.match(workflow, /publish\/official-core.lock.json --clobber/)
})
test('new official candidate is resolved once into an immutable lock without changing Portable source', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'core-discovery-'))
  await mkdir(path.join(root,'scripts'))
  await writeFile(path.join(root,'scripts/upstream-source-metadata.mjs'), 'export async function readOfficialSourceMetadata(){return {packageManager:"pnpm@11.7.0",packedFamilies:{dsh:251,vendor:9,landlock:1}}}')
  const original=JSON.stringify({dsh:{version:'0.1.2-rc.1',npmIntegrity:'sha512-0.1.2-rc.1'},defaultPlugins:{keep:'exact'}})
  await writeFile(path.join(root,'upstream.preview.lock.json'),original)
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.includes('registry.npmjs.org')){assert.equal(options.headers.authorization,undefined);return Response.json(registry)}
    if(url.endsWith('official-core.lock.json'))return new Response('',{status:404})
    if(url.includes('/git/ref/tags/'))return Response.json({object:{type:'commit',sha:'a'.repeat(40)}})
    if(url.endsWith('/THIRD_PARTY_NOTICES.md'))return new Response('official notices')
    throw Error('Unexpected request '+url)
  })
  const output=path.join(root,'resolved/lock.json')
  const result=await discoverCoreSource({portableRoot:root,channel:'candidate',output,token:'test-only'})
  const lock=JSON.parse(await readFile(output,'utf8'))
  assert.equal(result.version,'0.1.3-alpha.2')
  assert.equal(lock.dsh.reviewedCommit,'a'.repeat(40))
  assert.equal(lock.dsh.npmIntegrity,'sha512-0.1.3-alpha.2')
  assert.equal(lock.dsh.packedFamilies.dsh,251)
  assert.match(lock.dsh.noticesSha256,/^[a-f0-9]{64}$/)
  assert.deepEqual(lock.defaultPlugins,{keep:'exact'})
  assert.equal(await readFile(path.join(root,'upstream.preview.lock.json'),'utf8'),original)
})
