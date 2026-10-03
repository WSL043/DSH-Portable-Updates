import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverCoreSource, selectCoreRelease, defaultPeersInputHash } from '../scripts/discover-core-source.mjs'
import { updateQualificationState } from '../scripts/update-qualification-state.mjs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const versions = ['0.1.7-rc.2', '0.2.0-alpha.1', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0']
const registry = { 'dist-tags': { latest: '0.2.0', rc: '0.2.0-rc.2' }, versions: Object.fromEntries(versions.map(version =>
  [version, { dist: { integrity: `sha512-${version}` } }])) }
const current = { version: '0.1.7-rc.2', npmIntegrity: 'sha512-0.1.7-rc.2' }

test('the full published semver set chooses the newest three across alpha, rc, and final releases', () => {
  const selected = selectCoreRelease(registry, current, false, { baselineVersion: current.version })
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1'])
  assert.equal(selected.version, '0.2.0')
})

test('failure fallback remains inside the top-three window and never requeues older successful history', () => {
  const failedLatest = [{ sourceSha: 'shell', version: '0.2.0', status: 'failed', pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' },
    { sourceSha: 'old-shell', version: '0.1.7-rc.2', status: 'success' }]
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: failedLatest }).version, '0.2.0-rc.2')
  const twoFailed = [...failedLatest, { sourceSha: 'shell', version: '0.2.0-rc.2', status: 'failed', pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' }]
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: twoFailed }).version, '0.2.0-rc.1')
  const allFailed = [...twoFailed, { sourceSha: 'shell', version: '0.2.0-rc.1', status: 'failed', pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' }]
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: allFailed }).version, null)
})

test('after the newest core qualifies, older window versions are backfilled even below the bundled core', () => {
  const bundled = { version: '0.2.0', npmIntegrity: 'sha512-0.2.0' }
  const latestDone = [{ sourceSha: 'shell', version: '0.2.0', status: 'success' }]
  assert.equal(selectCoreRelease(registry, bundled, false, { baselineVersion: '0.2.0', sourceSha: 'shell', state: latestDone }).version, '0.2.0-rc.2')
  const twoDone = [...latestDone, { sourceSha: 'shell', version: '0.2.0-rc.2', status: 'success' }]
  assert.equal(selectCoreRelease(registry, bundled, false, { baselineVersion: '0.2.0', sourceSha: 'shell', state: twoDone }).version, '0.2.0-rc.1')
  const allDone = [...twoDone, { sourceSha: 'shell', version: '0.2.0-rc.1', status: 'success' }]
  assert.equal(selectCoreRelease(registry, bundled, false, { baselineVersion: '0.2.0', sourceSha: 'shell', state: allDone }).version, null)
})

test('deprecated or incomplete top-three versions do not widen discovery to version four', () => {
  const limited = structuredClone(registry)
  limited.versions['0.2.0'].deprecated = 'withdrawn'
  delete limited.versions['0.2.0-rc.2'].dist.integrity
  const selected = selectCoreRelease(limited, current)
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1'])
  assert.equal(selected.version, '0.2.0-rc.1')
  const outOfWindow = structuredClone(registry)
  outOfWindow.versions['0.2.0'].deprecated = 'withdrawn'
  outOfWindow.versions['0.2.0-rc.2'].deprecated = 'withdrawn'
  outOfWindow.versions['0.2.0-rc.1'].deprecated = 'withdrawn'
  assert.equal(selectCoreRelease(outOfWindow, current).version, null)
})

test('npm integrity and accepted-only refresh remain fail-closed', () => {
  assert.throws(() => selectCoreRelease(registry, { ...current, npmIntegrity: 'changed' }), /integrity changed/)
  assert.throws(() => selectCoreRelease({ versions: {} }, current), /no integrity/)
  assert.equal(selectCoreRelease(registry, { version: '0.2.0-rc.2', npmIntegrity: 'sha512-0.2.0-rc.2' }, true).version, '0.2.0-rc.2')
  assert.equal(selectCoreRelease(registry, current, true).version, null, 'an accepted core outside top three is rejected')
})

test('default-plugin peer holds and 24-hour failure cooling are preserved', () => {
  const peerHash = defaultPeersInputHash({ image: '1' }, 'checker', { semver: '7' })
  const blocked = { sourceSha: 'shell', pipelineSha: 'pipe', version: '0.2.0', status: 'blocked',
    adapter: 'default-plugin-peers', defaultPeersInputHash: peerHash }
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'new-pipe',
    defaultPeersInputHash: peerHash, state: [blocked] }).version, '0.2.0-rc.2')
  const state = updateQualificationState([], { sourceSha: 'shell', pipelineSha: 'pipe', version: '0.2.0',
    status: 'failed', attemptedAt: '2026-09-09T12:00:00Z' })
  assert.equal(state[0].retryAfter, '2026-09-10T12:00:00.000Z')
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe',
    now: Date.parse('2026-09-09T18:00:00Z'), state }).version, '0.2.0-rc.2')
})

test('new official source is locked only after immutable tag, npm integrity, and notice checks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'app'), { recursive: true })
  await writeFile(path.join(root, 'app/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.7.5' }))
  const original = JSON.stringify({ dsh: current, defaultPlugins: { keep: 'exact' } })
  await writeFile(path.join(root, 'upstream.lock.json'), original)
  await writeFile(path.join(root, 'upstream.preview.lock.json'), original)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url)
    if (request.pathname.includes('/releases/download/')) assert.ok(request.searchParams.has('_core_check'))
    if (request.hostname === 'registry.npmjs.org') {
      assert.equal(options.headers.authorization, undefined)
      return Response.json(registry)
    }
    if (request.pathname.endsWith('official-core.lock.json') || request.pathname.endsWith('qualification-state.json')) return new Response('', { status: 404 })
    if (request.pathname.endsWith('/git/ref/tags/dsh-v0.2.0')) return Response.json({ object: { type: 'tag', sha: 'c'.repeat(40) } })
    if (request.pathname.endsWith(`/git/tags/${'c'.repeat(40)}`)) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } })
    if (request.pathname.endsWith('/THIRD_PARTY_NOTICES.md')) return new Response('official notices')
    throw new Error(`Unexpected request ${url}`)
  })
  const output = path.join(root, 'resolved/lock.json')
  const selection = path.join(root, 'selection.json')
  const stateOutput = path.join(root, 'qualification-state.json')
  const result = await discoverCoreSource({ portableRoot: root, output, selection, stateOutput, sourceSha: 'published-shell' })
  const lock = JSON.parse(await readFile(output, 'utf8'))
  const selected = JSON.parse(await readFile(selection, 'utf8'))
  assert.equal(result.version, '0.2.0')
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1'])
  assert.equal(lock.dsh.reviewedCommit, 'a'.repeat(40))
  assert.equal(lock.dsh.integrity, 'sha512-0.2.0')
  assert.equal(lock.dsh.npmIntegrity, undefined)
  assert.match(lock.dsh.noticesSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(lock.defaultPlugins, { keep: 'exact' })
  assert.deepEqual(JSON.parse(await readFile(stateOutput, 'utf8')), [])
  assert.equal(await readFile(path.join(root, 'upstream.lock.json'), 'utf8'), original)
})

test('a version on npm without its release tag waits while the next window version is qualified', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'app'), { recursive: true })
  await writeFile(path.join(root, 'app/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.7.5' }))
  const original = JSON.stringify({ dsh: current, defaultPlugins: { keep: 'exact' } })
  await writeFile(path.join(root, 'upstream.lock.json'), original)
  await writeFile(path.join(root, 'upstream.preview.lock.json'), original)
  t.mock.method(globalThis, 'fetch', async url => {
    const request = new URL(url)
    if (request.hostname === 'registry.npmjs.org') return Response.json(registry)
    if (request.pathname.endsWith('official-core.lock.json') || request.pathname.endsWith('qualification-state.json')) return new Response('', { status: 404 })
    if (request.pathname.endsWith('/git/ref/tags/dsh-v0.2.0')) return new Response('', { status: 404 })
    if (request.pathname.endsWith('/git/ref/tags/dsh-v0.2.0-rc.2')) return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } })
    if (request.pathname.endsWith('/THIRD_PARTY_NOTICES.md')) return new Response('official notices')
    throw new Error(`Unexpected request ${url}`)
  })
  const output = path.join(root, 'resolved/lock.json')
  const selection = path.join(root, 'selection.json')
  const result = await discoverCoreSource({ portableRoot: root, output, selection,
    stateOutput: path.join(root, 'qualification-state.json'), sourceSha: 'published-shell' })
  const lock = JSON.parse(await readFile(output, 'utf8'))
  const selected = JSON.parse(await readFile(selection, 'utf8'))
  assert.equal(result.version, '0.2.0-rc.2')
  assert.equal(lock.dsh.reviewedCommit, 'b'.repeat(40))
  assert.deepEqual(selected.awaitingSourceTag, ['0.2.0'])
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1'])
})

test('only tagless versions left in the window skip the run without failing', () => {
  const selected = selectCoreRelease(registry, current, false, { awaitingSourceTag: ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1'] })
  assert.equal(selected.version, null)
  assert.equal(selected.status, 'skip')
  assert.equal(selected.reason, 'awaiting-source-tag')
})

test('accepted-only refresh canonicalizes the stable integrity field and makes no new upstream tag request', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-accepted-refresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'app'), { recursive: true })
  await writeFile(path.join(root, 'app/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.7.5' }))
  const published = { version: '0.2.0-rc.2', npmIntegrity: 'sha512-0.2.0-rc.2', reviewedCommit: 'b'.repeat(40) }
  const original = JSON.stringify({ dsh: current, defaultPlugins: { keep: 'stable-shell' } })
  await writeFile(path.join(root, 'upstream.lock.json'), original)
  t.mock.method(globalThis, 'fetch', async url => {
    const request = new URL(url)
    if (request.pathname.includes('/releases/download/')) assert.ok(request.searchParams.has('_core_check'))
    if (request.hostname === 'registry.npmjs.org') return Response.json(registry)
    if (request.pathname.endsWith('official-core.lock.json')) return Response.json({ dsh: published })
    if (request.pathname.endsWith('qualification-state.json')) return Response.json([])
    throw new Error(`Accepted-only refresh must not fetch an upstream tag: ${url}`)
  })
  const output = path.join(root, 'resolved/lock.json')
  const result = await discoverCoreSource({ portableRoot: root, output, selection: path.join(root, 'selection.json'),
    stateOutput: path.join(root, 'qualification-state.json'), acceptedOnly: true })
  const lock = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.version, published.version)
  assert.equal(lock.dsh.integrity, published.npmIntegrity)
  assert.equal(lock.dsh.npmIntegrity, undefined)
  assert.equal(lock.dsh.reviewedCommit, published.reviewedCommit)
  assert.deepEqual(lock.defaultPlugins, { keep: 'stable-shell' })
})

test('one five-platform qualification publishes channel-specific old-client envelopes over the same versions', async () => {
  const queue = await readFile(new URL('../.github/workflows/sync-core.yml', import.meta.url), 'utf8')
  const workflow = await readFile(new URL('../.github/workflows/sync-core-channel.yml', import.meta.url), 'utf8')
  const preview = await readFile(new URL('../.github/workflows/sync-preview-shell.yml', import.meta.url), 'utf8').catch(() => '')
  assert.match(queue, /remaining:\s+description: Additional bounded fallback runs after this one \(0 to 2\)[\s\S]*default: 2/)
  assert.doesNotMatch(queue, /needs\.stable|needs\.candidate/)
  assert.doesNotMatch(workflow, /shell_channel|inputs\.channel|SHELL_CHANNEL/)
  assert.match(workflow, /select-native-release\.mjs published-releases\.json/)
  assert.match(workflow, /for channel in stable candidate/)
  assert.match(workflow, /STATE_TAG: \$\{\{ needs\.resolve\.outputs\.state_tag \}\}/)
  assert.match(workflow, /matrix:\s+include:[\s\S]*linux-arm64/)
  assert.equal((workflow.match(/artifact: (?:windows|macos|linux)-/g) ?? []).length, 5)
  assert.equal(preview, '')
})
