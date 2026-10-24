import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions, isValidSemVer, sharesCoreRuntimeBaseline } from './build-core-index.mjs'
import { selectCoreWindow } from './core-window.mjs'
import { mergeQualificationStates } from './update-qualification-state.mjs'


function stateRecords(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.records)) return value.records
  if (value?.sourceSha && value?.version) return [value]
  return []
}

/**
 * Success records for cores the published catalog already offers for this shell contract. A core is qualified for the
 * shell interface it was built against, not for one Portable commit (docs/shell-contract.md in DSH-Portable), so a
 * new shell with the same contract and Node runtime keeps them without another five-platform run.
 */
export function retainedRecords({ topThree, index, contract, nodeVersion, sourceSha, state, attemptedAt }) {
  if (!Number.isInteger(contract) || !sourceSha || !Array.isArray(index?.versions)) return []
  const here = new Set(stateRecords(state).filter(item => item?.sourceSha === sourceSha && item?.status === 'success').map(item => item.version))
  return index.versions
    .filter(entry => topThree.includes(entry?.version) && !here.has(entry.version)
      && sharesCoreRuntimeBaseline(entry.manifest, { requiredShellContract: contract, component: { requiredNodeVersion: nodeVersion } }))
    .map(entry => ({ sourceSha, version: entry.version, status: 'success', attemptedAt, retainedFromContract: contract }))
}

export function defaultPeersInputHash(defaultPlugins, checker, dependencyLock) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return createHash('sha256').update(JSON.stringify(canonical({ schema: 1, defaultPlugins, checker, dependencyLock }))).digest('hex')
}

function cooling(record, now, pipelineSha, peersHash) {
  if (record?.status === 'blocked' && record.adapter === 'default-plugin-peers'
    && /^[a-f0-9]{64}$/.test(peersHash || '') && /^[a-f0-9]{64}$/.test(record.defaultPeersInputHash || ''))
    return record.defaultPeersInputHash === peersHash
  if (record?.status === 'blocked' && (!pipelineSha || record.pipelineSha === pipelineSha)) return true
  return record?.status === 'failed'
    && (!pipelineSha || record.pipelineSha === pipelineSha)
    && record.retryAfter
    && Number.isFinite(Date.parse(record.retryAfter))
    && Date.parse(record.retryAfter) > now
}

function latestThreeVersions(registry) {
  const sorted = Object.keys(registry?.versions ?? {})
    .filter(isValidSemVer)
    .sort((left, right) => compareVersions(right, left))
  return selectCoreWindow(sorted)
}

function eligibleReleases(registry, topThree, baselineVersion) {
  return topThree
    .map(version => ({ version, metadata: registry?.versions?.[version] }))
    // Every version in the core window is offered once it qualifies, including ones older than
    // the core bundled with this Portable release; users may roll back within the window.
    .filter(({ metadata }) => !metadata?.deprecated
      && typeof metadata?.dist?.integrity === 'string'
      && metadata.dist.integrity.length > 0)
    .map(({ version, metadata }) => ({ version, integrity: metadata.dist.integrity }))
}

export function selectCoreRelease(registry, current, acceptedOnly = false, {
  baselineVersion = current?.version,
  sourceSha = '',
  pipelineSha = '',
  defaultPeersInputHash: peersHash = '',
  state = [],
  rebuild = false,
  now = Date.now(),
  awaitingSourceTag = [],
} = {}) {
  const topThree = latestThreeVersions(registry)
  const allowed = new Set(topThree)
  const currentVersion = String(current?.version ?? '')
  const currentMetadata = registry?.versions?.[currentVersion]
  const currentIntegrity = currentMetadata?.dist?.integrity
  if (currentVersion && !currentIntegrity) throw new Error(`Official registry has no integrity for ${currentVersion}`)
  if (currentVersion && currentIntegrity !== (current.npmIntegrity || current.integrity)) {
    throw new Error('Pinned official package integrity changed')
  }
  const records = stateRecords(state)
  const candidates = acceptedOnly ? [] : eligibleReleases(registry, topThree, baselineVersion)
  const currentCandidate = currentVersion
    && allowed.has(currentVersion)
    && (!baselineVersion || compareVersions(currentVersion, baselineVersion) >= 0)
    && !currentMetadata?.deprecated
    ? { version: currentVersion, integrity: currentIntegrity }
    : null
  if (currentCandidate
    && rebuild) {
    return { ...currentCandidate, topThree, status: 'selected', reason: 'rebuild' }
  }
  if (currentCandidate
    && !candidates.some(candidate => candidate.version === currentVersion)) {
    candidates.push(currentCandidate)
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version))
  const awaiting = new Set(awaitingSourceTag)
  for (const candidate of candidates) {
    if (awaiting.has(candidate.version)) continue
    const record = records
      .filter(item => item?.sourceSha === sourceSha && item?.version === candidate.version)
      .sort((left, right) => String(right.attemptedAt ?? '').localeCompare(String(left.attemptedAt ?? '')))[0]
    if (record?.status === 'success' || cooling(record, now, pipelineSha, peersHash)) continue
    return { version: candidate.version, integrity: candidate.integrity, topThree, status: 'selected' }
  }
  return { version: null, integrity: null, topThree, status: 'skip',
    reason: awaiting.size ? 'awaiting-source-tag' : 'no-unverified-candidate' }
}

async function writeSelection(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n')
}

export async function discoverCoreSource({
  portableRoot,
  output,
  selection = 'selection.json',
  stateOutput = 'qualification-state.json',
  sourceSha = process.env.SOURCE_SHA || '',
  pipelineSha = process.env.PIPELINE_SHA || '',
  token = process.env.GITHUB_TOKEN,
  acceptedOnly = false,
  rebuild = false,
  rebuildVersion = '',
  prepareOnly = false,
  prepareVersion = '',
}) {
  if (prepareOnly && (acceptedOnly || rebuild || rebuildVersion)) throw new Error('Preparation cannot reuse publication refresh inputs.')
  if (prepareOnly ? !isValidSemVer(prepareVersion) : prepareVersion) throw new Error('An exact prepare version requires prepare-only mode.')
  if (rebuildVersion && !rebuild) throw new Error('A targeted refresh requires rebuild=true.')
  if (rebuildVersion && !isValidSemVer(rebuildVersion)) throw new Error('Invalid targeted rebuild version.')
  const lockFile = 'upstream.lock.json'
  const lock = JSON.parse(await readFile(path.join(portableRoot, lockFile), 'utf8'))
  const buildDependencies = structuredClone(lock.dsh.buildDependencies)
  const selectIdentity = identity => {
    const selected = structuredClone(identity)
    delete selected.buildDependencies
    if (buildDependencies !== undefined) selected.buildDependencies = structuredClone(buildDependencies)
    return selected
  }
  const product = JSON.parse(await readFile(path.join(portableRoot, 'package.json'), 'utf8'))
  if (typeof product.version !== 'string' || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(product.version)) {
    throw new Error('Published Portable product version is invalid')
  }
  const productLock = product.version.includes('-')
    ? JSON.parse(await readFile(path.join(portableRoot, 'upstream.preview.lock.json'), 'utf8'))
    : lock
  // Qualification and peer preflight use the plugins pinned by the exact
  // published Portable shell selected for this single lane.
  lock.defaultPlugins = productLock.defaultPlugins
  const peersHash = defaultPeersInputHash(productLock.defaultPlugins,
    await readFile(new URL('./preflight-adapters.mjs', import.meta.url), 'utf8'),
    JSON.parse(await readFile(path.join(portableRoot, 'app/package-lock.json'), 'utf8')))
  const attemptedAt = new Date().toISOString()
  await writeSelection(selection, {
    schemaVersion: 1,
    sourceSha: sourceSha || null,
    pipelineSha: pipelineSha || null,
    version: null,
    publish: false,
    status: 'resolving',
    attemptedAt,
  })
  async function get(url, json = true, optional = false) {
    const requestUrl = new URL(url)
    if (requestUrl.hostname === 'github.com' && requestUrl.pathname.includes('/releases/download/')) {
      requestUrl.searchParams.set('_core_check', String(Date.now()))
    }
    const response = await fetch(requestUrl.href, { signal: AbortSignal.timeout(60000), headers: {
      'user-agent': 'DSH-Portable-core-intake',
      ...(url.startsWith('https://api.github.com/') && token ? { authorization: `Bearer ${token}` } : {}),
    } })
    if (optional && response.status === 404) return null
    if (!response.ok) throw new Error(`Official source request failed: ${response.status} ${url}`)
    return json ? response.json() : response.text()
  }
  async function officialCommit(object) {
    if (object?.type === 'tag') object = (await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/tags/${object.sha}`)).object
    if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) throw new Error('Official release tag has no immutable commit')
    return object.sha
  }
  const registry = await get('https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  const topThree = latestThreeVersions(registry)
  if (topThree.length === 0) throw new Error('Official npm registry does not contain a valid DSH release.')
  if (rebuildVersion && !topThree.includes(rebuildVersion)) throw new Error('Targeted rebuild is outside the supported window.')
  const releaseBase = 'https://github.com/WSL043/DSH-Portable-Updates/releases/download/'
  const [canonicalLock, stableLock, candidateLock, canonicalState, stableState, candidateState] = await Promise.all([
    get(`${releaseBase}update-channel-core/official-core.lock.json`, true, true),
    get(`${releaseBase}update-channel-core-stable/official-core.lock.json`, true, true),
    get(`${releaseBase}update-channel-core-candidate/official-core.lock.json`, true, true),
    get(`${releaseBase}update-channel-core/qualification-state.json`, true, true),
    get(`${releaseBase}update-channel-core-stable/qualification-state.json`, true, true),
    get(`${releaseBase}update-channel-core-candidate/qualification-state.json`, true, true),
  ])
  const accepted = [canonicalLock, stableLock, candidateLock]
    .filter(value => value?.dsh?.version && topThree.includes(value.dsh.version))
    .sort((left, right) => compareVersions(right.dsh.version, left.dsh.version))[0]
  const state = mergeQualificationStates(topThree, canonicalState, stableState, candidateState)
  const contract = JSON.parse(await readFile(path.join(portableRoot, 'config/shell-contract.json'), 'utf8').catch(() => 'null'))?.contract
  let stableIndex = await get(`${releaseBase}update-channel-core-stable/dsh-core-index-windows-x64.json`, true, true).catch(() => null)
  let targeted = null
  let tagObject = null
  if (prepareOnly) {
    if (!topThree.includes(prepareVersion)) throw new Error('Preparation target is outside the supported window.')
    const metadata = registry.versions[prepareVersion]
    const integrity = metadata?.dist?.integrity
    if (metadata?.deprecated || typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('Preparation requires a non-deprecated official package with SHA-512 integrity.')
    tagObject = (await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v${prepareVersion}`)).object
    targeted = { version: prepareVersion, integrity, topThree, status: 'selected', reason: 'prepare-only' }
  } else if (rebuildVersion) {
    // Maintenance refreshes may replace only an already delivered core. Authenticate the exact catalog bytes
    // with the selected published shell's trust keys; never turn this input into arbitrary npm/source selection.
    const catalogUrl = `${releaseBase}update-channel-core-stable/dsh-core-index-windows-x64.json`
    const [catalogBytes, signature] = await Promise.all([get(catalogUrl, false), get(`${catalogUrl}.sig`, false)])
    const { verifyUpdateSignature } = await import(pathToFileURL(path.join(portableRoot, 'launcher/update-signature.mjs')))
    let verified = false
    try { verified = verifyUpdateSignature(Buffer.from(catalogBytes, 'utf8'), signature) } catch {}
    if (!verified) throw new Error('Published catalog signature is invalid.')
    const catalog = JSON.parse(catalogBytes)
    stableIndex = catalog
    const entry = catalog?.schemaVersion === 1 && catalog.channel === 'stable' && catalog.platform === 'windows-x64'
      ? catalog.versions?.find(item => item.version === rebuildVersion) : null
    if (!entry || entry.manifest?.component?.dshVersion !== rebuildVersion) throw new Error('Target is not in the published catalog.')
    if (!Number.isInteger(contract) || entry.manifest.requiredShellContract !== contract) throw new Error('Target shell contract differs from the published baseline.')
    const record = state.filter(item => item.version === rebuildVersion)
      .sort((a, b) => String(b.attemptedAt ?? '').localeCompare(String(a.attemptedAt ?? '')))[0]
    if (record?.status !== 'success') throw new Error('Target has no current successful qualification.')
    const published = (await get(`${releaseBase}update-channel-core-stable/official-core-${rebuildVersion}.lock.json`))?.dsh
    const metadata = registry.versions[rebuildVersion]
    const integrity = metadata?.dist?.integrity
    if (metadata?.deprecated || typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
      || integrity !== (published?.integrity || published?.npmIntegrity)
      || (published?.integrity && published?.npmIntegrity && published.integrity !== published.npmIntegrity)) throw new Error('Target registry integrity differs from the published lock.')
    if (published?.version !== rebuildVersion || published.package !== '@deepseek-ai/dsh'
      || published.tag !== `dsh-v${rebuildVersion}`
      || published.sourceRepository !== 'https://github.com/deepseek-ai/deepseek-harness') throw new Error('Published target source lock is invalid.')
    const commit = await officialCommit((await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v${rebuildVersion}`)).object)
    if (commit !== published.reviewedCommit || commit !== entry.manifest.component.dshCommit) throw new Error('Target official tag commit differs from the published lock/catalog commit.')
    lock.dsh = selectIdentity(published)
    targeted = { version: rebuildVersion, integrity, topThree, status: 'selected', reason: 'qualified-rebuild' }
  }
  state.push(...retainedRecords({ topThree, index: stableIndex, contract, nodeVersion: lock.node?.version, sourceSha, state, attemptedAt }))
  await writeSelection(stateOutput, state)
  // An accepted-only refresh reuses a published in-window core, never a newer
  // Portable source lock or an unqualified registry version.
  if (!targeted && accepted?.dsh && (acceptedOnly || compareVersions(accepted.dsh.version, lock.dsh.version) > 0)) lock.dsh = selectIdentity(accepted.dsh)
  // Upstream can publish to npm before it pushes the release tag. Such a version waits for its immutable
  // source; the next unqualified version in the window is tried instead, and the next run retries.
  const awaitingSourceTag = []
  let selected
  if (targeted) selected = targeted
  else for (;;) {
    selected = selectCoreRelease(registry, lock.dsh, acceptedOnly, {
      defaultPeersInputHash: peersHash,
      baselineVersion: productLock.dsh.version,
      sourceSha,
      pipelineSha,
      state,
      rebuild,
      awaitingSourceTag,
    })
    if (!selected.version || selected.version === lock.dsh.version) break
    const ref = await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v${selected.version}`, true, true)
    if (ref) {
      tagObject = ref.object
      break
    }
    awaitingSourceTag.push(selected.version)
  }
  await writeSelection(selection, {
    schemaVersion: 1,
    sourceSha: sourceSha || null,
    pipelineSha: pipelineSha || null,
    version: selected.version,
    topThree: selected.topThree,
    qualifiedVersions: [...new Set(state.filter(item => item.status === 'success' && item.sourceSha === sourceSha
      && selected.topThree.includes(item.version)).map(item => item.version))],
    defaultPeersInputHash: peersHash,
    publish: Boolean(selected.version),
    status: selected.status,
    reason: selected.reason,
    awaitingSourceTag,
    attemptedAt,
  })
  if (selected.version && (prepareOnly || selected.version !== lock.dsh.version)) {
    const commit = await officialCommit(tagObject)
    const notices = await get(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${commit}/THIRD_PARTY_NOTICES.md`, false)
    Object.assign(lock.dsh, { version: selected.version, tag: `dsh-v${selected.version}`, reviewedCommit: commit,
      noticesSha256: createHash('sha256').update(notices).digest('hex') })
    // The checked-out official release planner supplies these before any build.
    delete lock.dsh.packageManager
    delete lock.dsh.packedFamilies
  }
  if (selected.version) {
    lock.dsh.integrity = selected.integrity
    delete lock.dsh.npmIntegrity
  }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(lock, null, 2) + '\n')
  return { version: selected.version, commit: lock.dsh.reviewedCommit, lockFile, topThree: selected.topThree,
    acceptedOnly, publish: Boolean(selected.version) }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [portableRoot, output, selection, stateOutput] = process.argv.slice(2)
  console.log(JSON.stringify(await discoverCoreSource({
    portableRoot,
    output,
    selection,
    stateOutput,
    acceptedOnly: process.env.ACCEPTED_CORE_ONLY === 'true',
    rebuild: process.env.REBUILD_CORE === 'true',
    rebuildVersion: process.env.REBUILD_VERSION || '',
    prepareOnly: process.env.PREPARE_ONLY === 'true',
    prepareVersion: process.env.PREPARE_VERSION || '',
  })))
}
