import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { isValidSemVer } from '../scripts/build-core-index.mjs'
import { ADAPTERS, preflightAdapters, checkDefaultPluginCapabilities, checkDefaultPluginPeers, fetchPinnedDefaultPluginManifests,
  CONTRACT_DEFAULT_PLUGIN_BASELINES, readVerifiedDefaultPluginManifest, fetchContractDefaultPluginManifests,
  checkContractDefaultPluginBinding, bindCoreManifestDefaultPlugins } from '../scripts/preflight-adapters.mjs'
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
  const plugin = { name: 'dsh-chat-manager', version: '1.5.1', peerDependenciesMeta: {
    '@deepseek-ai/dsh-client-ui-conversation': { optional: true },
  }, peerDependencies: {
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
  const choose = options => selectCoreRelease(registry, current, false,
    {sourceSha:'old',pipelineSha:'pipeline',state,now:Date.parse('2030-01-01'),...options})
  assert.equal(choose({}).version, null)
  assert.equal(choose({sourceSha:'new'}).version, version)
  assert.equal(choose({pipelineSha:'fixed'}).version, version)
  assert.equal(choose({rebuild:true}).version, version)
})

const contractPeerRange = '0.2.1-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.5 || 0.2.0-rc.2'
const contractPeerLock = { defaultPlugins: {
  imageViewer: { package: 'dsh-image-viewer', version: '0.1.15' },
  chatManager: { package: 'dsh-chat-manager', version: '1.5.16' },
} }
const contractPeerManifest = { name: 'dsh-image-viewer', version: '0.1.15',
  peerDependencies: { '@deepseek-ai/dsh-client-ui-slots': contractPeerRange } }
const contractPeerManifests = { 'dsh-image-viewer': contractPeerManifest,
  'dsh-chat-manager': { ...contractPeerManifest, name: 'dsh-chat-manager', version: '1.5.16' } }
const peerSemver = {
  validRange: range => typeof range === 'string' && range.split(' || ').every(isValidSemVer) ? range : null,
  satisfies: (version, range) => range.split(' || ').includes(version),
}

test('the first published contract baseline stays frozen when a newer product advances', () => {
  assert.equal(CONTRACT_DEFAULT_PLUGIN_BASELINES[2].sourceSha, '389343b328d80488b9beadc5f81ce5123f23355c')
  assert.equal(Object.isFrozen(CONTRACT_DEFAULT_PLUGIN_BASELINES[2]), true)
  for (const version of ['0.2.1-rc.1', '0.2.1-rc.2']) {
    assert.equal(checkContractDefaultPluginBinding(2, contractPeerLock,
      contractPeerManifests, version, peerSemver).binding, 'contract')
  }
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-alpha.2']) {
    const result = checkContractDefaultPluginBinding(2, contractPeerLock,
      contractPeerManifests, version, peerSemver)
    assert.equal(result.binding, 'exact')
    assert.equal(result.peerStatus, 'blocked')
    assert.equal(result.baselineSource, CONTRACT_DEFAULT_PLUGIN_BASELINES[2].sourceSha)
  }
})

test('unverified or malformed contract peer metadata cannot become an exact-binding success', () => {
  const check = manifest => checkContractDefaultPluginBinding(2, contractPeerLock,
    { ...contractPeerManifests, 'dsh-image-viewer': manifest }, '0.2.1-rc.3', peerSemver)
  for (const changed of [
    { ...contractPeerManifest, name: 'unexpected' },
    { ...contractPeerManifest, version: '0.1.16' },
    { ...contractPeerManifest, peerDependencies: undefined },
    { ...contractPeerManifest, peerDependencies: {} },
    { ...contractPeerManifest, peerDependencies: [] },
    { ...contractPeerManifest, peerDependencies: { '@deepseek-ai/dsh-client-ui-slots': null } },
    { ...contractPeerManifest, peerDependencies: { '@deepseek-ai/dsh-client-ui-slots': 'not a range' } },
  ]) assert.throws(() => check(changed), /metadata|range/)
  assert.throws(() => checkContractDefaultPluginBinding(3, contractPeerLock, {}, '0.2.1-rc.2', peerSemver), /No reviewed/)
  assert.throws(() => checkContractDefaultPluginBinding(2, {}, {}, '0.2.1-rc.2', peerSemver), /no pinned/)
  assert.throws(() => checkContractDefaultPluginBinding(2, { defaultPlugins: { imageViewer: contractPeerLock.defaultPlugins.imageViewer } }, contractPeerManifests, '0.2.1-rc.2', peerSemver), /membership/)
})

function pinnedManifestArchive(manifest, { copies = 1 } = {}) {
  const raw = Buffer.from(JSON.stringify(manifest) + '\n')
  const header = Buffer.alloc(512)
  header.write('package/package.json')
  header.write(raw.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.fill(32, 148, 156)
  header[156] = 48
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  const entry = Buffer.concat([header, raw, Buffer.alloc((512 - raw.length % 512) % 512)])
  const archive = gzipSync(Buffer.concat([...Array(copies).fill(entry), Buffer.alloc(1024)]))
  return { archive, pin: { package: manifest.name, version: manifest.version,
    sha256: createHash('sha256').update(archive).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') },
    manifestSha256: createHash('sha256').update(raw).digest('hex') }
}

test('contract peers are read from the SHA-verified npm pack manifest, not registry peer metadata', () => {
  const fixture = pinnedManifestArchive(contractPeerManifest)
  assert.deepEqual(readVerifiedDefaultPluginManifest(fixture.archive, fixture.pin, fixture.manifestSha256), contractPeerManifest)
  assert.throws(() => readVerifiedDefaultPluginManifest(fixture.archive,
    { ...fixture.pin, sha256: '0'.repeat(64) }, fixture.manifestSha256), /archive digest/)
  assert.throws(() => readVerifiedDefaultPluginManifest(fixture.archive,
    { ...fixture.pin, integrity: 'sha512-' + 'A'.repeat(86) + '==' }, fixture.manifestSha256), /archive digest/)
  assert.throws(() => readVerifiedDefaultPluginManifest(fixture.archive, fixture.pin, '0'.repeat(64)), /manifest digest/)
  assert.throws(() => readVerifiedDefaultPluginManifest(fixture.archive,
    { ...fixture.pin, version: 'wrong' }, fixture.manifestSha256), /manifest identity/)
  const duplicate = pinnedManifestArchive(contractPeerManifest, { copies: 2 })
  assert.throws(() => readVerifiedDefaultPluginManifest(duplicate.archive, duplicate.pin, duplicate.manifestSha256), /manifest identity/)
})

test('an unknown contract stops before any network request', async () => {
  let requests = 0
  await assert.rejects(fetchContractDefaultPluginManifests(99, async () => { requests++; throw new Error('unexpected request') }), /No reviewed/)
  assert.equal(requests, 0)
})

test('narrowing a core envelope changes only the existing contract field and is idempotent', () => {
  const manifest = { schemaVersion: 1, updateKind: 'engine', portableVersion: '0.9.8',
    requiredShellContract: 2, requiredShellFingerprint: 'a'.repeat(64), requiredShellSchema: 25,
    component: { kind: 'dsh-runtime-capsule', dshVersion: '0.2.1-rc.3', sha256: 'b'.repeat(64), bytes: 123 } }
  const identity = { portableVersion: '0.9.8', shellContract: 2 }
  const unchanged = structuredClone(manifest)
  assert.deepEqual(bindCoreManifestDefaultPlugins(manifest, 'contract', identity), manifest)
  const exact = bindCoreManifestDefaultPlugins(manifest, 'exact', identity)
  const expected = structuredClone(manifest)
  delete expected.requiredShellContract
  assert.deepEqual(exact, expected)
  assert.deepEqual(manifest, unchanged)
  assert.deepEqual(bindCoreManifestDefaultPlugins(exact, 'exact', identity), exact)
  assert.throws(() => bindCoreManifestDefaultPlugins(exact, 'contract', identity), /cannot be widened/)
  for (const bad of [
    { ...manifest, portableVersion: '0.9.7' },
    { ...manifest, requiredShellFingerprint: '' },
    { ...manifest, requiredShellContract: 3 },
    { ...manifest, requiredShellContract: null },
  ]) assert.throws(() => bindCoreManifestDefaultPlugins(bad, 'exact', identity), /cannot be bound/)
})
