import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverCoreSource, selectCoreRelease, defaultPeersInputHash } from '../scripts/discover-core-source.mjs'
import { updateQualificationState } from '../scripts/update-qualification-state.mjs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

const versions = ['0.1.7-rc.2', '0.2.0-alpha.1', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0']
const registry = { 'dist-tags': { latest: '0.2.0', rc: '0.2.0-rc.2' }, versions: Object.fromEntries(versions.map(version =>
  [version, { dist: { integrity: `sha512-${version}` } }])) }
const current = { version: '0.1.7-rc.2', npmIntegrity: 'sha512-0.1.7-rc.2' }

test('targeted refresh only rebuilds an already qualified signed-catalog version', async t => {
  const qualified = ['0.2.1-rc.2', '0.2.1-rc.1', '0.2.1-alpha.5']
  const cases = [
    ...qualified.map(version => ({ name: `allows ${version}`, version })),
    { name: 'prepares new rc3 without published qualification', version: '0.2.1-rc.3', prepareOnly: true },
    { name: 'preparation ignores a prior hold', version: '0.2.1-alpha.4', prepareOnly: true, blocked: true },
    { name: 'preparation rejects outside window', version: '9.9.9', prepareOnly: true, error: /window/ },
    { name: 'preparation rejects missing immutable tag', version: '0.2.1-rc.3', prepareOnly: true, missingTag: true, error: /Official source request failed: 404/ },
    { name: 'requires explicit rebuild', rebuild: false, error: /requires.*rebuild/ },
    { name: 'rejects tagless rc3', version: '0.2.1-rc.3', error: /published catalog/ },
    { name: 'rejects blocked target', version: '0.2.1-alpha.4', blocked: true, error: /successful qualification/ },
    { name: 'rejects arbitrary target', version: '9.9.9', error: /window/ },
    { name: 'rejects changed SRI', badIntegrity: true, error: /integrity/ },
    { name: 'rejects changed official tag', badTag: true, error: /commit/ },
    { name: 'rejects a missing official tag', missingTag: true, error: /Official source request failed: 404/ },
    { name: 'rejects changed published commit', badCommit: true, error: /commit/ },
    { name: 'rejects invalid catalog signature', badSignature: true, error: /signature/ },
    { name: 'rejects another shell contract', badContract: true, error: /contract/ },
  ]
  for (const scenario of cases) await t.test(scenario.name, async st => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'core-targeted-refresh-'))
    st.after(() => rm(root, { recursive: true, force: true }))
    for (const directory of ['app', 'config', 'launcher']) await mkdir(path.join(root, directory))
    const version = scenario.version || qualified[1]
    const sri = v => `sha512-${createHash('sha512').update(v).digest('base64')}`
    const commits = Object.fromEntries([...qualified, '0.2.1-alpha.4', '0.2.1-rc.3'].map((v, i) => [v, String(i + 1).repeat(40)]))
    const dsh = v => ({ package: '@deepseek-ai/dsh', version: v, tag: `dsh-v${v}`, sourceRepository: 'https://github.com/deepseek-ai/deepseek-harness',
      reviewedCommit: commits[v], npmIntegrity: sri(v), noticesSha256: 'a'.repeat(64) })
    const buildDependencies = { zod: { version: '4.6.7', integrity: sri('reviewed-zod') } }
    const original = JSON.stringify({ dsh: { ...dsh(qualified[0]), buildDependencies }, defaultPlugins: { keep: 'published-shell' } })
    await writeFile(path.join(root, 'upstream.lock.json'), original)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.9.5' }))
    await writeFile(path.join(root, 'app/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
    await writeFile(path.join(root, 'config/shell-contract.json'), JSON.stringify({ contract: 2 }))
    const registry = { versions: Object.fromEntries(['0.2.1-rc.3', ...qualified, '0.2.1-alpha.4'].map(v => [v, { dist: { integrity: sri(v) } }])) }
    const catalogVersions = scenario.blocked ? [...qualified, version] : qualified
    const catalog = JSON.stringify({ schemaVersion: 1, channel: 'stable', platform: 'windows-x64', versions: catalogVersions.map(v => ({ version: v,
      manifest: { requiredShellContract: scenario.badContract && v === version ? 3 : 2, component: { dshVersion: v, dshCommit: commits[v] } } })) })
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = publicKey.export({ type: 'spki', format: 'pem' })
    await writeFile(path.join(root, 'launcher/update-signature.mjs'), `import { verify } from 'node:crypto'; export const verifyUpdateSignature = (bytes, signature) => verify('sha256', bytes, { key: ${JSON.stringify(pem)}, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature.trim(), 'base64'));`)
    const signature = scenario.badSignature ? 'invalid' : sign('sha256', Buffer.from(catalog), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
    const state = catalogVersions.map(v => ({ version: v, sourceSha: 'a'.repeat(40), status: scenario.blocked && v === version ? 'blocked' : 'success', attemptedAt: '2026-10-21T00:00:00Z' }))
    st.mock.method(globalThis, 'fetch', async url => {
      const request = new URL(url), name = request.pathname.split('/').at(-1)
      if (request.hostname === 'registry.npmjs.org') return Response.json(registry)
      if (name === 'dsh-core-index-windows-x64.json') return new Response(catalog)
      if (name === 'dsh-core-index-windows-x64.json.sig') return new Response(signature)
      if (name === 'qualification-state.json') return Response.json(state)
      if (name === 'official-core.lock.json') return Response.json(JSON.parse(original))
      if (name === `official-core-${version}.lock.json`) return Response.json({ dsh: { ...dsh(version), buildDependencies: { zod: { version: '4.4.3' } },
        ...(scenario.badIntegrity ? { npmIntegrity: 'sha512-changed' } : {}), ...(scenario.badCommit ? { reviewedCommit: 'f'.repeat(40) } : {}) } })
      if (request.pathname.endsWith(`/git/ref/tags/dsh-v${version}`)) return scenario.missingTag ? new Response('', { status: 404 }) : Response.json({ object: { type: 'commit', sha: scenario.badTag ? 'e'.repeat(40) : commits[version] } })
      if (name === 'THIRD_PARTY_NOTICES.md') return new Response('official notices')
      throw new Error(`Unexpected request ${url}`)
    })
    const output = path.join(root, 'resolved/lock.json')
    const call = () => discoverCoreSource({ portableRoot: root, output, selection: path.join(root, 'selection.json'), stateOutput: path.join(root, 'state.json'),
      sourceSha: 'b'.repeat(40), rebuild: scenario.prepareOnly ? false : scenario.rebuild !== false,
      rebuildVersion: scenario.prepareOnly ? '' : version, prepareOnly: scenario.prepareOnly || false, prepareVersion: scenario.prepareOnly ? version : '' })
    if (scenario.error) await assert.rejects(call, scenario.error)
    else {
      assert.equal((await call()).version, version)
      const locked = JSON.parse(await readFile(output, 'utf8'))
      assert.equal(locked.dsh.reviewedCommit, commits[version])
      assert.equal(locked.dsh.integrity, sri(version))
      assert.deepEqual(locked.defaultPlugins, { keep: 'published-shell' })
      assert.deepEqual(locked.dsh.buildDependencies, buildDependencies, 'Use the selected Portable dependency policy, not an older accepted core policy')
      if (scenario.prepareOnly) assert.equal(JSON.parse(await readFile(path.join(root, 'selection.json'), 'utf8')).reason, 'prepare-only')
      assert.equal(await readFile(path.join(root, 'upstream.lock.json'), 'utf8'), original)
    }
  })
})

test('the local plugin poll requests the official dsh-v release tag before dispatching', async () => {
  const source = await readFile(new URL('../scripts/poll-upstream.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('async function dispatchPluginAutopilots(version) {')
  const end = source.indexOf('\nconst times =', start)
  assert.ok(start >= 0 && end > start)
  const requests = []
  await runInNewContext(`${source.slice(start, end)}\ndispatchPluginAutopilots('0.2.1-rc.2')`, {
    fetch: async url => { requests.push(url); return { ok: false } },
    run: () => { throw new Error('An unavailable upstream release must not dispatch plugin workflows') },
  })
  assert.deepEqual(requests, ['https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.2.1-rc.2'])
})

test('the full published semver set chooses the newest five across alpha, rc, and final releases', () => {
  const selected = selectCoreRelease(registry, current, false, { baselineVersion: current.version })
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1', '0.2.0-alpha.1', '0.1.7-rc.2'])
  assert.equal(selected.version, '0.2.0')
})

test('alphas never push the newest release candidate out of the window', () => {
  const crowded = ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3']
  const reg = { versions: Object.fromEntries(crowded.map(version => [version, { dist: { integrity: `sha512-${version}` } }])) }
  const selected = selectCoreRelease(reg, { version: '0.2.0-rc.2', npmIntegrity: 'sha512-0.2.0-rc.2' }, false, { baselineVersion: '0.2.0-rc.2' })
  assert.deepEqual(selected.topThree, ['0.2.1-alpha.3', '0.2.1-alpha.2', '0.2.1-alpha.1', '0.2.0-rc.2'])
  const alphaFlood = ['0.2.0-rc.2', '0.2.0-rc.1', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5']
  const flooded = { versions: Object.fromEntries(alphaFlood.map(version => [version, { dist: { integrity: `sha512-${version}` } }])) }
  const floodedSelection = selectCoreRelease(flooded, { version: '0.2.0-rc.2', npmIntegrity: 'sha512-0.2.0-rc.2' }, false, { baselineVersion: '0.2.0-rc.2' })
  assert.deepEqual(floodedSelection.topThree, ['0.2.1-alpha.5', '0.2.1-alpha.4', '0.2.1-alpha.3', '0.2.0-rc.2', '0.2.0-rc.1'], 'two release candidates always stay offered')
})

test('failure fallback remains inside the top-three window and never requeues older successful history', () => {
  const failedLatest = [{ sourceSha: 'shell', version: '0.2.0', status: 'failed', pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' },
    { sourceSha: 'old-shell', version: '0.1.7-rc.2', status: 'success' }]
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: failedLatest }).version, '0.2.0-rc.2')
  const twoFailed = [...failedLatest, { sourceSha: 'shell', version: '0.2.0-rc.2', status: 'failed', pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' }]
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: twoFailed }).version, '0.2.0-rc.1')
  const allFailed = [...twoFailed, { sourceSha: 'shell', version: '0.2.0-rc.1', status: 'failed', pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' }]
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: allFailed }).version, '0.2.0-alpha.1')
  const fiveFailed = [...allFailed, ...['0.2.0-alpha.1', '0.1.7-rc.2'].map(version => ({ sourceSha: 'shell', version, status: 'failed', pipelineSha: 'pipe', retryAfter: '2099-01-01T00:00:00Z' }))]
  assert.equal(selectCoreRelease(registry, current, false, { sourceSha: 'shell', pipelineSha: 'pipe', state: fiveFailed }).version, null)
})

test('after the newest core qualifies, older window versions are backfilled even below the bundled core', () => {
  const bundled = { version: '0.2.0', npmIntegrity: 'sha512-0.2.0' }
  const latestDone = [{ sourceSha: 'shell', version: '0.2.0', status: 'success' }]
  assert.equal(selectCoreRelease(registry, bundled, false, { baselineVersion: '0.2.0', sourceSha: 'shell', state: latestDone }).version, '0.2.0-rc.2')
  const twoDone = [...latestDone, { sourceSha: 'shell', version: '0.2.0-rc.2', status: 'success' }]
  assert.equal(selectCoreRelease(registry, bundled, false, { baselineVersion: '0.2.0', sourceSha: 'shell', state: twoDone }).version, '0.2.0-rc.1')
  const allDone = [...twoDone, { sourceSha: 'shell', version: '0.2.0-rc.1', status: 'success' }]
  assert.equal(selectCoreRelease(registry, bundled, false, { baselineVersion: '0.2.0', sourceSha: 'shell', state: allDone }).version, '0.2.0-alpha.1')
  const fiveDone = [...allDone, { sourceSha: 'shell', version: '0.2.0-alpha.1', status: 'success' }, { sourceSha: 'shell', version: '0.1.7-rc.2', status: 'success' }]
  assert.equal(selectCoreRelease(registry, bundled, false, { baselineVersion: '0.2.0', sourceSha: 'shell', state: fiveDone }).version, null)
})

test('deprecated or incomplete top-three versions do not widen discovery to version four', () => {
  const limited = structuredClone(registry)
  limited.versions['0.2.0'].deprecated = 'withdrawn'
  delete limited.versions['0.2.0-rc.2'].dist.integrity
  const selected = selectCoreRelease(limited, current)
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1', '0.2.0-alpha.1', '0.1.7-rc.2'])
  assert.equal(selected.version, '0.2.0-rc.1')
  const outOfWindow = structuredClone(registry)
  outOfWindow.versions['0.2.0'].deprecated = 'withdrawn'
  outOfWindow.versions['0.2.0-rc.2'].deprecated = 'withdrawn'
  outOfWindow.versions['0.2.0-rc.1'].deprecated = 'withdrawn'
  outOfWindow.versions['0.2.0-alpha.1'].deprecated = 'withdrawn'
  outOfWindow.versions['0.1.7-rc.2'].deprecated = 'withdrawn'
  assert.equal(selectCoreRelease(outOfWindow, current).version, null)
})

test('npm integrity and accepted-only refresh remain fail-closed', () => {
  assert.throws(() => selectCoreRelease(registry, { ...current, npmIntegrity: 'changed' }), /integrity changed/)
  assert.throws(() => selectCoreRelease({ versions: {} }, current), /no integrity/)
  assert.equal(selectCoreRelease(registry, { version: '0.2.0-rc.2', npmIntegrity: 'sha512-0.2.0-rc.2' }, true).version, '0.2.0-rc.2')
  assert.equal(selectCoreRelease({ versions: { ...registry.versions, '0.1.6': { dist: { integrity: 'sha512-0.1.6' } }, '0.1.5': { dist: { integrity: 'sha512-0.1.5' } } } }, { version: '0.1.5', npmIntegrity: 'sha512-0.1.5' }, true).version, null, 'an accepted core outside the window is rejected')
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
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1', '0.2.0-alpha.1', '0.1.7-rc.2'])
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
  assert.deepEqual(selected.topThree, ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1', '0.2.0-alpha.1', '0.1.7-rc.2'])
})

test('only tagless versions left in the window skip the run without failing', () => {
  const selected = selectCoreRelease(registry, current, false, { awaitingSourceTag: ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.1', '0.2.0-alpha.1', '0.1.7-rc.2'] })
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
  assert.match(queue, /rebuild_version:[\s\S]*type: string[\s\S]*default: ''/)
  assert.match(queue, /rebuild_version: \$\{\{ inputs\.rebuild_version \|\| '' \}\}/)
  assert.match(workflow, /REBUILD_VERSION: \$\{\{ inputs\.rebuild_version \|\| '' \}\}/)
  assert.doesNotMatch(queue, /needs\.stable|needs\.candidate/)
  assert.doesNotMatch(workflow, /shell_channel|inputs\.channel|SHELL_CHANNEL/)
  assert.match(workflow, /select-native-release\.mjs published-releases\.json/)
  assert.match(workflow, /for channel in stable candidate/)
  assert.match(workflow, /STATE_TAG: \$\{\{ needs\.resolve\.outputs\.state_tag \}\}/)
  assert.match(workflow, /matrix:\s+include:[\s\S]*linux-arm64/)
  assert.equal((workflow.match(/artifact: (?:windows|macos|linux)-/g) ?? []).length, 5)
  assert.equal(preview, '')
})

test('cores the catalog already offers for this shell contract are retained, others still need a run', async () => {
  const { retainedRecords } = await import('../scripts/discover-core-source.mjs')
  const index = { versions: [
    { version: '0.2.1-rc.2', manifest: { requiredShellContract: 1, component: { requiredNodeVersion: '24.22.1' } } },
    { version: '0.2.1-rc.1', manifest: { requiredShellContract: 1, component: { requiredNodeVersion: '24.22.1' } } },
    { version: '0.2.1-alpha.5', manifest: { requiredShellContract: 2, component: { requiredNodeVersion: '24.22.1' } } },
    { version: '0.2.1-alpha.4', manifest: { requiredShellContract: 1, component: { requiredNodeVersion: '24.19.0' } } },
    { version: '0.2.0', manifest: { requiredShellContract: 1, component: { requiredNodeVersion: '24.22.1' } } },
  ] }
  const topThree = ['0.2.1-rc.2', '0.2.1-rc.1', '0.2.1-alpha.5', '0.2.1-alpha.4']
  const state = [{ sourceSha: 'new', version: '0.2.1-rc.2', status: 'success' }]
  const records = retainedRecords({ topThree, index, contract: 1, nodeVersion: '24.22.1', sourceSha: 'new', state, attemptedAt: 'now' })
  assert.deepEqual(records.map(item => item.version), ['0.2.1-rc.1'], 'already qualified on this shell, wrong contract and out-of-window versions are not added')
  assert.equal(records[0].status, 'success')
  assert.deepEqual(retainedRecords({ topThree, index, contract: 1, sourceSha: 'new', state: [], attemptedAt: 'now' }), [], 'Unknown Node baseline cannot inherit success')
  assert.deepEqual(retainedRecords({ topThree, index, contract: undefined, sourceSha: 'new', state: [], attemptedAt: 'now' }), [])
})
