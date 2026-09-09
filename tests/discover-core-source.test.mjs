import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverCoreSource, selectCoreRelease } from '../scripts/discover-core-source.mjs'
import { updateQualificationState } from '../scripts/update-qualification-state.mjs'
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

test('discovery walks registry history instead of relying on dist-tags', () => {
  const history = { versions: Object.fromEntries([
    '0.1.2-rc.1', '0.1.3-alpha.1', '0.1.3-beta.1', '0.1.4-alpha.1',
  ].map(version => [version, {dist:{integrity:`sha512-${version}`}}])) }
  const selected = selectCoreRelease(history, 'candidate', {
    version: '0.1.2-rc.1', npmIntegrity: 'sha512-0.1.2-rc.1',
  }, false, {baselineVersion:'0.1.2-rc.1', sourceSha:'portable-sha'})
  assert.equal(selected.version, '0.1.4-alpha.1')
})

test('selection filters deprecated or incomplete versions and retains an accepted stable RC baseline', () => {
  const filtered = { versions: {
    '0.1.3': {deprecated:'withdrawn', dist:{integrity:'sha512-0.1.3'}},
    '0.1.2': {dist:{}},
    '0.1.1': {dist:{integrity:'sha512-0.1.1'}},
    '0.1.2-rc.1': {dist:{integrity:'sha512-0.1.2-rc.1'}},
  } }
  const selected = selectCoreRelease(filtered, 'stable', {
    version:'0.1.2-rc.1', integrity:'sha512-0.1.2-rc.1',
  }, false, {baselineVersion:'0.1.2-rc.1', sourceSha:'portable-sha'})
  assert.equal(selected.version, '0.1.2-rc.1')
})

test('stable fallback rejects accepted Alpha/Beta and deprecated RC versions', () => {
  const registry = { versions: {
    '0.1.2-beta.1': {dist:{integrity:'sha512-0.1.2-beta.1'}},
    '0.1.2-rc.1': {deprecated:'withdrawn', dist:{integrity:'sha512-0.1.2-rc.1'}},
  } }
  const selected = selectCoreRelease(registry, 'stable', {
    version:'0.1.2-beta.1', integrity:'sha512-0.1.2-beta.1',
  }, false, {baselineVersion:'0.1.2-beta.1', sourceSha:'portable-sha'})
  assert.equal(selected.version, null)
})

test('failed candidates cool down without blocking history or a retry on a new shell SHA', () => {
  const history = { versions: Object.fromEntries([
    '0.1.2-rc.1', '0.1.3-alpha.1', '0.1.4-alpha.1',
  ].map(version => [version, {dist:{integrity:`sha512-${version}`}}])) }
  const state = [{
    sourceSha:'old-shell', version:'0.1.4-alpha.1', status:'failed',
    attemptedAt:'2026-09-09T00:00:00.000Z', retryAfter:'2026-09-10T00:00:00.000Z',
  }]
  const retryLater = selectCoreRelease(history, 'candidate', {
    version:'0.1.2-rc.1', npmIntegrity:'sha512-0.1.2-rc.1',
  }, false, {baselineVersion:'0.1.2-rc.1', sourceSha:'old-shell', state, now:Date.parse('2026-09-09T12:00:00.000Z')})
  assert.equal(retryLater.version, '0.1.3-alpha.1')
  const newShell = selectCoreRelease(history, 'candidate', {
    version:'0.1.2-rc.1', npmIntegrity:'sha512-0.1.2-rc.1',
  }, false, {baselineVersion:'0.1.2-rc.1', sourceSha:'new-shell', state, now:Date.parse('2026-09-09T12:00:00.000Z')})
  assert.equal(newShell.version, '0.1.4-alpha.1')
})

test('rebuild explicitly reselects the accepted version despite a successful state record', () => {
  const current = {version:'0.1.2-rc.1', npmIntegrity:'sha512-0.1.2-rc.1'}
  const selected = selectCoreRelease(registry, 'candidate', current, false, {
    baselineVersion:'0.1.2-rc.1', sourceSha:'portable-sha', rebuild:true,
    state:[{sourceSha:'portable-sha',version:'0.1.3-alpha.2',status:'success'}],
  })
  assert.equal(selected.version, current.version)
  assert.equal(selected.reason, 'rebuild')
})

test('a corrected intake pipeline retries failures without rebuilding successful cores', () => {
  const current = { version: '0.1.2-rc.1', npmIntegrity: 'sha512-0.1.2-rc.1' }
  const state = [
    { sourceSha: 'shell', pipelineSha: 'old-pipeline', version: '0.1.3-alpha.2', status: 'failed', retryAfter: '2099-01-01T00:00:00Z' },
    ...Object.keys(registry.versions).filter(version => version !== '0.1.3-alpha.2')
      .map(version => ({ sourceSha: 'shell', pipelineSha: 'old-pipeline', version, status: 'success' })),
  ]
  assert.equal(selectCoreRelease(registry, 'candidate', current, false,
    { sourceSha: 'shell', pipelineSha: 'old-pipeline', state }).version, null)
  assert.equal(selectCoreRelease(registry, 'candidate', current, false,
    { sourceSha: 'shell', pipelineSha: 'fixed-pipeline', state }).version, '0.1.3-alpha.2')
})

test('qualification state replaces one attempt and gives failures a 24-hour retry window', () => {
  const attemptedAt = '2026-09-09T12:00:00.000Z'
  const failed = updateQualificationState([], {
    sourceSha:'portable-sha', version:'0.1.4-alpha.1', status:'failed', attemptedAt,
  })
  assert.equal(failed.length, 1)
  assert.equal(failed[0].retryAfter, '2026-09-10T12:00:00.000Z')
  const success = updateQualificationState(failed, {
    sourceSha:'portable-sha', version:'0.1.4-alpha.1', status:'success', attemptedAt:'2026-09-11T12:00:00.000Z',
  })
  assert.deepEqual(success, [{sourceSha:'portable-sha',version:'0.1.4-alpha.1',status:'success',attemptedAt:'2026-09-11T12:00:00.000Z',retryAfter:null}])
})

test('a fully qualified channel has no selected version or build request', () => {
  const state = Object.keys(registry.versions).map(version => ({
    sourceSha: 'same-shell', version, status: 'success',
  }))
  const result = selectCoreRelease(registry, 'candidate', {
    version: '0.1.2-rc.1', npmIntegrity: 'sha512-0.1.2-rc.1',
  }, false, { sourceSha: 'same-shell', state })
  assert.equal(result.version, null)
  assert.equal(result.status, 'skip')
})

test('upstream provenance failure preserves the selected identity for the failure recorder', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-discovery-failure-'))
  const original = JSON.stringify({ dsh: { version: '0.1.2-rc.1', npmIntegrity: 'sha512-0.1.2-rc.1' } })
  await writeFile(path.join(root, 'upstream.preview.lock.json'), original)
  await writeFile(path.join(root, 'upstream.lock.json'), original)
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('registry.npmjs.org')) return Response.json(registry)
    if (url.endsWith('official-core.lock.json') || url.endsWith('qualification-state.json')) return new Response('', { status: 404 })
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } })
    if (url.endsWith('/THIRD_PARTY_NOTICES.md')) throw new Error('upstream provenance unavailable')
    throw new Error(`Unexpected request ${url}`)
  })
  const selection = path.join(root, 'selection.json')
  await assert.rejects(discoverCoreSource({
    portableRoot: root, channel: 'candidate', output: path.join(root, 'lock.json'),
    selection, sourceSha: 'published-shell',
  }), /upstream provenance unavailable/)
  const record = JSON.parse(await readFile(selection, 'utf8'))
  assert.equal(record.sourceSha, 'published-shell')
  assert.equal(record.version, '0.1.3-alpha.2')
  assert.equal(record.status, 'selected')
})

test('accepted-only refresh preserves the published immutable core when newer source is incompatible', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'core-accepted-refresh-'))
  const published={version:'0.1.3-alpha.2',npmIntegrity:'sha512-0.1.3-alpha.2',reviewedCommit:'b'.repeat(40),packedFamilies:{dsh:251,vendor:9,landlock:1}}
  const original=JSON.stringify({dsh:{version:'0.1.2-rc.1',npmIntegrity:'sha512-0.1.2-rc.1'},defaultPlugins:{keep:'current-shell'}})
  await writeFile(path.join(root,'upstream.preview.lock.json'),original)
  await writeFile(path.join(root,'upstream.lock.json'),original)
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.includes('registry.npmjs.org'))return Response.json({...registry,'dist-tags':{alpha:'0.1.5-alpha.1'}})
    if(url.endsWith('official-core.lock.json'))return Response.json({dsh:published})
    if(url.endsWith('qualification-state.json'))return new Response('',{status:404})
    throw Error('Accepted-only must not fetch new upstream source: '+url)
  })
  const output=path.join(root,'resolved/lock.json')
  const selection=path.join(root,'selection.json')
  const result=await discoverCoreSource({portableRoot:root,channel:'candidate',output,selection,acceptedOnly:true})
  const lock=JSON.parse(await readFile(output,'utf8'))
  assert.equal(result.acceptedOnly,true)
  assert.deepEqual(lock.dsh,published)
  assert.deepEqual(lock.defaultPlugins,{keep:'current-shell'})
  assert.equal(await readFile(path.join(root,'upstream.preview.lock.json'),'utf8'),original)
})
test('source packing, platform builds and publication all consume the discovered lock', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-core-channel.yml', import.meta.url), 'utf8')
  assert.equal(workflow.split('run: cp resolved-core/lock.json "$LOCK_FILE"').length - 1, 3)
  assert.match(workflow, /publish: \$\{\{ steps.selection.outputs.publish \}\}/)
  assert.match(workflow, /needs: \[resolve, build\]/)
  assert.match(workflow, /releases\/latest/)
  assert.match(workflow, /git\/ref\/tags\/\$RELEASE_TAG/)
  assert.match(workflow, /head_sha=\$SOURCE_SHA/)
  assert.match(workflow, /resolved-selection-\$\{\{ inputs.channel \}\}/)
  assert.match(workflow, /node update-channel\/scripts\/update-qualification-state\.mjs/)
  assert.match(workflow, /publish\/official-core\.lock\.json .*publish\/official-core-\*\.lock\.json/)
  assert.match(workflow, /landlockCount/)
})
test('new official candidate is resolved once into an immutable lock without changing Portable source', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'core-discovery-'))
  const original=JSON.stringify({dsh:{version:'0.1.2-rc.1',npmIntegrity:'sha512-0.1.2-rc.1'},defaultPlugins:{keep:'exact'}})
  await writeFile(path.join(root,'upstream.preview.lock.json'),original)
  await writeFile(path.join(root,'upstream.lock.json'),original)
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.includes('registry.npmjs.org')){assert.equal(options.headers.authorization,undefined);return Response.json(registry)}
    if(url.endsWith('official-core.lock.json'))return new Response('',{status:404})
    if(url.endsWith('qualification-state.json'))return new Response('',{status:404})
    if(url.includes('/git/ref/tags/'))return Response.json({object:{type:'commit',sha:'a'.repeat(40)}})
    if(url.endsWith('/THIRD_PARTY_NOTICES.md'))return new Response('official notices')
    throw Error('Unexpected request '+url)
  })
  const output=path.join(root,'resolved/lock.json')
  const selection=path.join(root,'selection.json')
  const result=await discoverCoreSource({portableRoot:root,channel:'candidate',output,selection,token:'test-only'})
  const lock=JSON.parse(await readFile(output,'utf8'))
  assert.equal(result.version,'0.1.3-alpha.2')
  assert.equal(lock.dsh.reviewedCommit,'a'.repeat(40))
  assert.equal(lock.dsh.npmIntegrity,'sha512-0.1.3-alpha.2')
  assert.equal(lock.dsh.packedFamilies,undefined, 'package counts are resolved from the checked-out official planner')
  assert.match(lock.dsh.noticesSha256,/^[a-f0-9]{64}$/)
  assert.equal(JSON.parse(await readFile(selection,'utf8')).version,'0.1.3-alpha.2')
  assert.deepEqual(lock.defaultPlugins,{keep:'exact'})
  assert.equal(await readFile(path.join(root,'upstream.preview.lock.json'),'utf8'),original)
})
