import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions } from './build-core-index.mjs'

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const STABLE_CURRENT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/
const PREVIEW_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:alpha|beta|rc)\.[1-9]\d*$/
const DISCOVERY_LIMIT = 20

function stateRecords(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.records)) return value.records
  if (value?.sourceSha && value?.version) return [value]
  return []
}

function cooling(record, now, pipelineSha) {
  return record?.status === 'failed'
    && (!pipelineSha || record.pipelineSha === pipelineSha)
    && record.retryAfter
    && Number.isFinite(Date.parse(record.retryAfter))
    && Date.parse(record.retryAfter) > now
}

function eligibleReleases(registry, channel, baselineVersion) {
  const pattern = channel === 'stable' ? STABLE_VERSION : PREVIEW_VERSION
  return Object.entries(registry?.versions ?? {})
    .filter(([version, metadata]) => pattern.test(version)
      && (!baselineVersion || compareVersions(version, baselineVersion) >= 0)
      && !metadata?.deprecated
      && typeof metadata?.dist?.integrity === 'string'
      && metadata.dist.integrity.length > 0)
    .map(([version, metadata]) => ({ version, integrity: metadata.dist.integrity }))
    .sort((left, right) => compareVersions(right.version, left.version))
    .slice(0, DISCOVERY_LIMIT)
}

export function selectCoreRelease(registry, channel, current, acceptedOnly = false, {
  baselineVersion = current?.version,
  sourceSha = '',
  pipelineSha = '',
  state = [],
  rebuild = false,
  now = Date.now(),
} = {}) {
  if (!['stable', 'candidate'].includes(channel)) throw new Error('Unknown core channel')
  const currentVersion = String(current?.version ?? '')
  const currentMetadata = registry?.versions?.[currentVersion]
  const currentIntegrity = currentMetadata?.dist?.integrity
  if (currentVersion && !currentIntegrity) throw new Error(`Official registry has no integrity for ${currentVersion}`)
  if (currentVersion && currentIntegrity !== (current.npmIntegrity || current.integrity)) {
    throw new Error('Pinned official package integrity changed')
  }
  const records = stateRecords(state)
  const candidates = acceptedOnly ? [] : eligibleReleases(registry, channel, baselineVersion)
  const currentPattern = channel === 'stable' ? STABLE_CURRENT_VERSION : PREVIEW_VERSION
  // A newer Portable baseline must not permanently erase previously qualified
  // rollback choices. Rebuild at most five recent historical cores against it;
  // their old success is only eligibility, never proof of current compatibility.
  if (!acceptedOnly) {
    const history = [...new Set(records.filter(item => item.status === 'success').map(item => item.version))]
      .filter(version => currentPattern.test(version)
        && compareVersions(version, baselineVersion) < 0)
      .sort((a, b) => compareVersions(b, a)).slice(0, 5)
    for (const version of history) {
      const metadata = registry?.versions?.[version]
      if (!metadata?.deprecated && typeof metadata?.dist?.integrity === 'string' && metadata.dist.integrity) {
        candidates.push({ version, integrity: metadata.dist.integrity })
      }
    }
  }
  const currentCandidate = currentVersion
    && currentPattern.test(currentVersion)
    && (!baselineVersion || compareVersions(currentVersion, baselineVersion) >= 0)
    && !currentMetadata?.deprecated
    ? { version: currentVersion, integrity: currentIntegrity }
    : null
  if (currentCandidate
    && rebuild) {
    return { ...currentCandidate, status: 'selected', reason: 'rebuild' }
  }
  if (currentCandidate
    && !candidates.some(candidate => candidate.version === currentVersion)) {
    candidates.push(currentCandidate)
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version))
  for (const candidate of candidates) {
    const record = records
      .filter(item => item?.sourceSha === sourceSha && item?.version === candidate.version)
      .sort((left, right) => String(right.attemptedAt ?? '').localeCompare(String(left.attemptedAt ?? '')))[0]
    if (record?.status === 'success' || cooling(record, now, pipelineSha)) continue
    return { version: candidate.version, integrity: candidate.integrity, status: 'selected' }
  }
  return { version: null, integrity: null, status: 'skip', reason: 'no-unverified-candidate' }
}

async function writeSelection(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n')
}

export async function discoverCoreSource({
  portableRoot,
  channel,
  output,
  selection = 'selection.json',
  sourceSha = process.env.SOURCE_SHA || '',
  pipelineSha = process.env.PIPELINE_SHA || '',
  token = process.env.GITHUB_TOKEN,
  acceptedOnly = false,
  rebuild = false,
}) {
  const lockFile = channel === 'stable' ? 'upstream.lock.json' : 'upstream.preview.lock.json'
  const lock = JSON.parse(await readFile(path.join(portableRoot, lockFile), 'utf8'))
  const stableLock = JSON.parse(await readFile(path.join(portableRoot, 'upstream.lock.json'), 'utf8'))
  const attemptedAt = new Date().toISOString()
  await writeSelection(selection, {
    schemaVersion: 1,
    channel,
    sourceSha: sourceSha || null,
    pipelineSha: pipelineSha || null,
    version: null,
    publish: false,
    status: 'resolving',
    attemptedAt,
  })
  async function get(url, json = true, optional = false) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000), headers: {
      'user-agent': 'DSH-Portable-core-intake',
      ...(url.startsWith('https://api.github.com/') && token ? { authorization: `Bearer ${token}` } : {}),
    } })
    if (optional && response.status === 404) return null
    if (!response.ok) throw new Error(`Official source request failed: ${response.status} ${url}`)
    return json ? response.json() : response.text()
  }
  const registry = await get('https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  const accepted = await get(`https://github.com/WSL043/DSH-Portable-Updates/releases/download/${process.env.CORE_CHANNEL_TAG || `update-channel-core-${channel}`}/official-core.lock.json`, true, true)
  const state = await get(`https://github.com/WSL043/DSH-Portable-Updates/releases/download/${process.env.CORE_CHANNEL_TAG || `update-channel-core-${channel}`}/qualification-state.json`, true, true)
  if (accepted?.dsh && compareVersions(accepted.dsh.version, lock.dsh.version) > 0) lock.dsh = accepted.dsh
  const selected = selectCoreRelease(registry, channel, lock.dsh, acceptedOnly, {
    baselineVersion: stableLock.dsh.version,
    sourceSha,
    pipelineSha,
    state,
    rebuild,
  })
  await writeSelection(selection, {
    schemaVersion: 1,
    channel,
    sourceSha: sourceSha || null,
    pipelineSha: pipelineSha || null,
    version: selected.version,
    publish: Boolean(selected.version),
    status: selected.status,
    reason: selected.reason,
    attemptedAt,
  })
  if (selected.version && selected.version !== lock.dsh.version) {
    let object = (await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v${selected.version}`)).object
    if (object?.type === 'tag') object = (await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/tags/${object.sha}`)).object
    if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) throw new Error('Official release tag has no immutable commit')
    const notices = await get(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${object.sha}/THIRD_PARTY_NOTICES.md`, false)
    Object.assign(lock.dsh, { version: selected.version, tag: `dsh-v${selected.version}`, reviewedCommit: object.sha,
      noticesSha256: createHash('sha256').update(notices).digest('hex') })
    // The checked-out official release planner supplies these before any build.
    delete lock.dsh.packageManager
    delete lock.dsh.packedFamilies
    lock.dsh[channel === 'stable' ? 'integrity' : 'npmIntegrity'] = selected.integrity
  }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(lock, null, 2) + '\n')
  return { version: selected.version, commit: lock.dsh.reviewedCommit, lockFile, acceptedOnly, publish: Boolean(selected.version) }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [portableRoot, channel, output, selection] = process.argv.slice(2)
  console.log(JSON.stringify(await discoverCoreSource({
    portableRoot,
    channel,
    output,
    selection,
    acceptedOnly: process.env.ACCEPTED_CORE_ONLY === 'true',
    rebuild: process.env.REBUILD_CORE === 'true',
  })))
}
