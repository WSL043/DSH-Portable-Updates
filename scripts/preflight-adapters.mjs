import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidSemVer } from './build-core-index.mjs'

export const ADAPTERS = ['session-export-ui', 'permission-localization', 'theme-bootstrap',
  'native-boot-handoff', 'native-settings-command', 'loopback-connection',
  'portable-hero-context', 'client-module-startup', 'windows-subprocess-hide']

export function checkDefaultPluginCapabilities(lock, workspaceClient) {
  // This exact shipped client uses the official session-menu extension, not a
  // copied workspace. Do not qualify an older host by merely skipping its UI test.
  if (lock.defaultPlugins?.chatManager?.version === '1.5.0'
    && !workspaceClient.includes('"sidebar.workspaces.session.menu.item"')) {
    return { status: 'blocked', adapter: 'default-plugin-host-capability',
      reason: 'Bundled Session Manager 1.5.0 requires the official session-menu slot missing from this core.' }
  }
  return { status: 'success' }
}

export function checkDefaultPluginPeers(lock, manifests, dshVersion, satisfies) {
  for (const pin of Object.values(lock.defaultPlugins ?? {})) {
    const manifest = manifests[pin.package]
    if (manifest?.name !== pin.package || manifest.version !== pin.version) {
      return { status: 'failed', adapter: 'default-plugin-peers',
        reason: `Pinned plugin metadata could not be verified: ${pin.package}@${pin.version}.` }
    }
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      // Optional means the host may omit this peer, not that a present, mismatched
      // DSH client API is compatible. Portable's runtime guard checks it too.
      if (!peer.startsWith('@deepseek-ai/dsh-')) continue
      if (typeof range !== 'string' || !satisfies(dshVersion, range, { includePrerelease: true })) {
        return { status: 'blocked', adapter: 'default-plugin-peers',
          reason: `${pin.package}@${pin.version} requires ${peer} ${range}; candidate core is ${dshVersion}. Publish and qualify a compatible default plugin before delivering this core.` }
      }
    }
  }
  return { status: 'success' }
}

export async function fetchPinnedDefaultPluginManifests(lock, request = fetch) {
  const manifests = {}
  for (const pin of Object.values(lock.defaultPlugins ?? {})) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pin.package)}/${encodeURIComponent(pin.version)}`
    const response = await request(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DSH-Portable-core-preflight' } })
    if (!response.ok) throw new Error(`Pinned plugin metadata request failed: ${pin.package}@${pin.version} (${response.status})`)
    manifests[pin.package] = await response.json()
  }
  return manifests
}


/** The first public contract-2 shell; never move this anchor when a feed advances. */
export const CONTRACT_DEFAULT_PLUGIN_BASELINES = Object.freeze({
  2: Object.freeze({
    sourceSha: '389343b328d80488b9beadc5f81ce5123f23355c',
    manifestSha256: Object.freeze({
      'dsh-image-viewer': '3e08ab5f3a401868dd563258935284ffcef537c6e1975f25688ed5778da6ec49',
      'dsh-chat-manager': 'c8ff4480f2eedbc04034854d185c0f52b766a8904254d5718b6457f11a248bcc',
    }),
  }),
})

function contractBaseline(contract) {
  if (!Number.isSafeInteger(contract) || contract < 1 || !Object.hasOwn(CONTRACT_DEFAULT_PLUGIN_BASELINES, contract)) {
    throw new Error('No reviewed default-plugin baseline for this shell contract.')
  }
  return CONTRACT_DEFAULT_PLUGIN_BASELINES[contract]
}

/** Read the real published package.json only after authenticating its pinned archive and manifest bytes. */
export function readVerifiedDefaultPluginManifest(archive, pin, manifestSha256) {
  if (!Buffer.isBuffer(archive) || archive.length > 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(pin?.sha256 ?? '')
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin?.integrity ?? '')
    || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? '')) throw new Error('Invalid pinned default-plugin archive identity.')
  if (createHash('sha256').update(archive).digest('hex') !== pin.sha256
    || 'sha512-' + createHash('sha512').update(archive).digest('base64') !== pin.integrity) {
    throw new Error('Pinned default-plugin archive digest differs.')
  }
  const tar = gunzipSync(archive, { maxOutputLength: 8 * 1024 * 1024 })
  const manifests = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0]
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const checksumText = header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim()
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(checksumText)) throw new Error('Invalid pinned package TAR header.')
    const size = Number.parseInt(sizeText, 8)
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length
      || checksum !== Number.parseInt(checksumText, 8)) throw new Error('Invalid pinned package TAR bounds or checksum.')
    if (name === 'package/package.json') {
      if (header[156] !== 0 && header[156] !== 48) throw new Error('Pinned package manifest must be a regular file.')
      const bytes = tar.subarray(offset + 512, offset + 512 + size)
      if (bytes.length > 256 * 1024 || createHash('sha256').update(bytes).digest('hex') !== manifestSha256) {
        throw new Error('Pinned default-plugin manifest digest differs.')
      }
      manifests.push(JSON.parse(bytes.toString('utf8')))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (manifests.length !== 1 || manifests[0]?.name !== pin.package || manifests[0]?.version !== pin.version) {
    throw new Error('Pinned default-plugin manifest identity differs.')
  }
  return manifests[0]
}

async function boundedResponse(response, limit) {
  if (!response.ok) throw new Error(`Contract default-plugin request failed (${response.status}).`)
  const length = Number(response.headers?.get('content-length'))
  if (Number.isFinite(length) && length > limit) throw new Error('Contract default-plugin response is too large.')
  const chunks = []
  let bytes = 0
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > limit) throw new Error('Contract default-plugin response is too large.')
      chunks.push(Buffer.from(chunk))
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer())
    if (chunk.length > limit) throw new Error('Contract default-plugin response is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function fetchContractDefaultPluginManifests(contract, request = fetch) {
  const baseline = contractBaseline(contract)
  const source = `https://raw.githubusercontent.com/WSL043/DSH-Portable/${baseline.sourceSha}`
  const get = async (url, limit) => boundedResponse(await request(url, {
    signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DSH-Portable-contract-defaults' },
  }), limit)
  const [configuration, lock] = await Promise.all(['config/shell-contract.json', 'upstream.lock.json']
    .map(async file => JSON.parse((await get(`${source}/${file}`, 512 * 1024)).toString('utf8'))))
  if (configuration?.schemaVersion !== 1 || configuration.contract !== contract
    || !lock.defaultPlugins || Array.isArray(lock.defaultPlugins)) throw new Error('Frozen contract baseline metadata differs.')
  const pins = Object.values(lock.defaultPlugins)
  const names = pins.map(pin => pin?.package)
  if (names.length !== Object.keys(baseline.manifestSha256).length || new Set(names).size !== names.length
    || names.some(name => !Object.hasOwn(baseline.manifestSha256, name))) throw new Error('Frozen contract default-plugin membership differs.')
  const manifests = Object.fromEntries(await Promise.all(pins.map(async pin => {
    if (typeof pin.version !== 'string' || !isValidSemVer(pin.version)
      || pin.url !== `https://registry.npmjs.org/${pin.package}/-/${pin.package}-${pin.version}.tgz`) {
      throw new Error('Frozen contract default-plugin package URL differs.')
    }
    const url = `https://registry.npmjs.org/${pin.package}/-/${pin.package}-${pin.version}.tgz`
    return [pin.package, readVerifiedDefaultPluginManifest(await get(url, 1024 * 1024), pin, baseline.manifestSha256[pin.package])]
  })))
  return { lock, manifests, baselineSource: baseline.sourceSha }
}

/** Metadata errors stop publication; a verified peer mismatch narrows the existing envelope. */
export function checkContractDefaultPluginBinding(contract, lock, manifests, dshVersion, semver) {
  const baseline = contractBaseline(contract)
  if (!isValidSemVer(dshVersion) || typeof semver?.satisfies !== 'function' || typeof semver.validRange !== 'function') {
    throw new Error('A valid candidate and pinned semver verifier are required.')
  }
  const pins = Object.values(lock?.defaultPlugins ?? {})
  const names = pins.map(pin => pin?.package)
  if (!pins.length) throw new Error('Contract baseline has no pinned default plugins.')
  if (pins.length !== Object.keys(baseline.manifestSha256).length || new Set(names).size !== names.length
    || names.some(name => !Object.hasOwn(baseline.manifestSha256, name))) throw new Error('Contract default-plugin membership is invalid.')
  for (const pin of pins) {
    const manifest = manifests?.[pin?.package]
    const peers = manifest?.peerDependencies
    if (manifest?.name !== pin?.package || manifest?.version !== pin?.version
      || !peers || typeof peers !== 'object' || Array.isArray(peers)) throw new Error('Contract default-plugin peer metadata is invalid.')
    const hostPeers = Object.entries(peers).filter(([peer]) => peer.startsWith('@deepseek-ai/dsh-'))
    if (!hostPeers.length || hostPeers.some(([, range]) => typeof range !== 'string' || !range.trim()
      || !semver.validRange(range, { includePrerelease: true }))) throw new Error('Contract default-plugin peer range is invalid.')
  }
  const result = checkDefaultPluginPeers(lock, manifests, dshVersion, semver.satisfies)
  if (result.status !== 'success' && result.status !== 'blocked') throw new Error(result.reason || 'Contract default-plugin peer verification failed.')
  return { status: 'success', binding: result.status === 'success' ? 'contract' : 'exact',
    baselineSource: baseline.sourceSha, peerStatus: result.status, ...(result.reason ? { reason: result.reason } : {}) }
}

/** Empty defaults qualify only this published product; optional plugins cannot hold its core intake. */
export async function resolveCoreDefaultPluginBinding(contract, productLock, dshVersion, semver, request = fetch) {
  if (!Number.isSafeInteger(contract) || contract < 1 || !isValidSemVer(dshVersion)) {
    throw new Error('A valid shell contract and core version are required.')
  }
  const defaults = productLock?.defaultPlugins
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('Published default-plugin membership is invalid.')
  }
  if (Object.keys(defaults).length === 0) return { status: 'success', binding: 'exact',
    baselineSource: '', reason: 'This published Portable baseline has no default plugins; preserve its exact shell envelope.' }
  const { lock, manifests } = await fetchContractDefaultPluginManifests(contract, request)
  return checkContractDefaultPluginBinding(contract, lock, manifests, dshVersion, semver)
}

export function bindCoreManifestDefaultPlugins(manifest, binding, { portableVersion, shellContract }) {
  if (!['contract', 'exact'].includes(binding) || !isValidSemVer(portableVersion)
    || !Number.isSafeInteger(shellContract) || shellContract < 1 || manifest?.updateKind !== 'engine'
    || manifest.portableVersion !== portableVersion || !/^[a-f0-9]{64}$/.test(manifest.requiredShellFingerprint ?? '')
    || (Object.hasOwn(manifest, 'requiredShellContract') && manifest.requiredShellContract !== shellContract)) {
    throw new Error('Core envelope cannot be bound to this verified Portable baseline.')
  }
  if (binding === 'contract' && manifest.requiredShellContract !== shellContract) {
    throw new Error('A missing contract cannot be widened during promotion.')
  }
  const bound = structuredClone(manifest)
  if (binding === 'exact') delete bound.requiredShellContract
  return bound
}

export async function preflightPinnedDefaultPlugins(root, lockFile) {
  const candidate = JSON.parse(await readFile(lockFile, 'utf8'))
  const product = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const productLock = JSON.parse(await readFile(path.join(root, product.version.includes('-') ? 'upstream.preview.lock.json' : 'upstream.lock.json'), 'utf8'))
  const semver = createRequire(path.resolve(root, 'app/package.json'))('semver')
  return checkDefaultPluginPeers(productLock, await fetchPinnedDefaultPluginManifests(productLock), candidate.dsh.version, semver.satisfies)
}

export function preflightAdapters(root, app, run = spawnSync) {
  for (const adapter of ADAPTERS) {
    const result = run(process.execPath, [path.resolve(root, 'scripts', `patch-${adapter}.mjs`), path.resolve(app)],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (result.status === 0 && !result.error) continue
    // Only explicit structural incompatibility is permanent for this baseline.
    // Missing files, process errors and other failures retain ordinary retry rules.
    const structural = !result.error && result.status !== 0
      && /seam changed upstream|expected 1 match, found \d+/.test(result.stderr ?? '')
    return { status: structural ? 'blocked' : 'failed', adapter,
      detail: String(result.error?.message || result.stderr || '').slice(-4000),
      reason: structural ? 'Published Portable adapter needs a new compatible baseline.' : 'Adapter preflight failed; inspect retained job logs.' }
  }
  return { status: 'success' }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [first, second, third] = process.argv.slice(2)
  if (first === '--contract-default-peers') {
    const root = path.resolve(second)
    const contract = JSON.parse(await readFile(path.join(root, 'config/shell-contract.json'), 'utf8')).contract
    const candidate = JSON.parse(await readFile(third, 'utf8'))
    const product = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const productLock = JSON.parse(await readFile(path.join(root, product.version.includes('-') ? 'upstream.preview.lock.json' : 'upstream.lock.json'), 'utf8'))
    const semver = createRequire(path.join(root, 'app/package.json'))('semver')
    const result = await resolveCoreDefaultPluginBinding(contract, productLock, candidate.dsh.version, semver)
    console.error(JSON.stringify(result))
    console.log('binding=' + result.binding)
    console.log('baseline_source=' + result.baselineSource)
  } else if (first === '--bind-core-envelope') {
    const files = {
      'windows-x64': 'artifacts/dsh-core-update-windows-x64.json',
      'macos-arm64': 'artifacts/dsh-core-update-macos-arm64.json',
      'macos-x64': 'artifacts/dsh-core-update-macos-x64.json',
      'linux-x64': 'artifacts/dsh-core-update-linux-x64.json',
      'linux-arm64': 'artifacts/dsh-core-update-linux-arm64.json',
    }
    if (!Object.hasOwn(files, second)) throw new Error('Unsupported core envelope platform.')
    const [product, configuration, manifest] = await Promise.all(['package.json', 'config/shell-contract.json', files[second]]
      .map(async file => JSON.parse(await readFile(file, 'utf8'))))
    const bound = bindCoreManifestDefaultPlugins(manifest, third, { portableVersion: product.version, shellContract: configuration.contract })
    await writeFile(files[second], JSON.stringify(bound, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify({ binding: third, platform: second, portableVersion: bound.portableVersion }))
  } else {
    const peersOnly = first === '--default-peers-only'
    const [root, app, lockFile] = peersOnly ? [second, null, third] : [first, second, third]
    let result = { status: 'success' }
    if (peersOnly) {
      result = await preflightPinnedDefaultPlugins(root, lockFile)
    } else if (lockFile) {
      const lock = JSON.parse(await readFile(lockFile, 'utf8'))
      const product = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      const productLock = JSON.parse(await readFile(path.join(root, product.version.includes('-') ? 'upstream.preview.lock.json' : 'upstream.lock.json'), 'utf8'))
      const client = await readFile(path.join(app, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'), 'utf8')
      result = checkDefaultPluginCapabilities(productLock, client)
    }
    if (!peersOnly && result.status === 'success') result = preflightAdapters(root, app)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `\nCore integration preflight: **${result.status}**${result.adapter ? ` (${result.adapter}) — ${result.reason}` : ''}\n`)
    console.log(JSON.stringify(result))
    // A known peer mismatch is a qualified hold, not a broken workflow. The
    // caller records it in selection.json and the channel qualification state.
    if (result.status !== 'success' && !(peersOnly && result.status === 'blocked')) process.exitCode = 1
  }
}
