import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions } from './build-core-index.mjs'

export function selectCoreRelease(registry, channel, current, acceptedOnly = false) {
  if (!['stable', 'candidate'].includes(channel)) throw new Error('Unknown core channel')
  const tags = registry?.['dist-tags'] || {}
  const allowed = acceptedOnly ? [] : channel === 'stable' ? ['latest'] : ['alpha', 'beta', 'rc', 'next', 'latest']
  const pattern = channel === 'stable' ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+-(alpha|beta|rc)\.[1-9]\d*$/
  let version = current.version
  for (const tag of allowed) {
    const candidate = tags[tag]
    if (typeof candidate !== 'string' || !pattern.test(candidate)) continue
    if (compareVersions(candidate, version) > 0) version = candidate
  }
  const integrity = registry?.versions?.[version]?.dist?.integrity
  if (!integrity) throw new Error(`Official registry has no integrity for ${version}`)
  if (version === current.version && integrity !== (current.npmIntegrity || current.integrity)) throw new Error('Pinned official package integrity changed')
  return { version, integrity }
}

export async function discoverCoreSource({ portableRoot, channel, output, token = process.env.GITHUB_TOKEN, acceptedOnly = false }) {
  const lockFile = channel === 'stable' ? 'upstream.lock.json' : 'upstream.preview.lock.json'
  const lock = JSON.parse(await readFile(path.join(portableRoot, lockFile), 'utf8'))
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
  const accepted = await get(`https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-${channel}/official-core.lock.json`, true, true)
  if (accepted?.dsh && compareVersions(accepted.dsh.version, lock.dsh.version) > 0) lock.dsh = accepted.dsh
  const selected = selectCoreRelease(registry, channel, lock.dsh, acceptedOnly)
  if (selected.version !== lock.dsh.version) {
    let object = (await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v${selected.version}`)).object
    if (object?.type === 'tag') object = (await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/git/tags/${object.sha}`)).object
    if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) throw new Error('Official release tag has no immutable commit')
    const { readOfficialSourceMetadata } = await import(pathToFileURL(path.join(portableRoot, 'scripts/upstream-source-metadata.mjs')))
    const metadata = await readOfficialSourceMetadata(object.sha, { json: get, text: url => get(url, false) })
    const notices = await get(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${object.sha}/THIRD_PARTY_NOTICES.md`, false)
    Object.assign(lock.dsh, { version: selected.version, tag: `dsh-v${selected.version}`, reviewedCommit: object.sha,
      noticesSha256: createHash('sha256').update(notices).digest('hex'), ...metadata })
    lock.dsh[channel === 'stable' ? 'integrity' : 'npmIntegrity'] = selected.integrity
  }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(lock, null, 2) + '\n')
  return { version: lock.dsh.version, commit: lock.dsh.reviewedCommit, lockFile, acceptedOnly }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [portableRoot, channel, output] = process.argv.slice(2)
  console.log(JSON.stringify(await discoverCoreSource({ portableRoot, channel, output, acceptedOnly: process.env.ACCEPTED_CORE_ONLY === 'true' })))
}
