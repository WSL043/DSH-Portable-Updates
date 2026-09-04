import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/
const PLATFORMS = new Set(['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'])

function parseVersion(value) {
  const match = VERSION.exec(String(value ?? ''))
  if (!match) return null
  return { core: match.slice(1, 4).map(Number), stage: match[4] ?? 'stable', number: Number(match[5] ?? 0) }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  const rank = { alpha: 0, beta: 1, rc: 2, stable: 3 }
  return rank[a.stage] === rank[b.stage] ? a.number - b.number : rank[a.stage] - rank[b.stage]
}

function validManifest(manifest, version) {
  return manifest?.updateKind === 'engine'
    && manifest?.component?.dshVersion === version
    && Array.isArray(manifest?.component?.urls)
    && manifest.component.urls.length > 0
    && manifest.component.urls.every(url => {
      try { return new URL(url).protocol === 'https:' } catch { return false }
    })
}

function versionedManifestName(platform, version) {
  return `dsh-core-update-${platform}-${version}.json`
}

function releaseBase(channel) {
  return `https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-${channel}`
}

export async function buildCoreIndex({
  channel,
  platform,
  currentManifest,
  previousIndex = null,
  previousLatestManifest = null,
  output,
}) {
  if (!['stable', 'candidate'].includes(channel)) throw new Error(`Unsupported core channel: ${channel}`)
  if (!PLATFORMS.has(platform)) throw new Error(`Unsupported core platform: ${platform}`)
  const currentVersion = String(currentManifest?.component?.dshVersion ?? '')
  if (!parseVersion(currentVersion) || !validManifest(currentManifest, currentVersion)) {
    throw new Error('Current engine update manifest is invalid.')
  }
  await mkdir(output, { recursive: true })
  const base = releaseBase(channel)
  const manifests = new Map([[currentVersion, currentManifest]])
  const entries = []

  for (const candidate of previousIndex?.schemaVersion === 1 && Array.isArray(previousIndex.versions)
    ? previousIndex.versions
    : []) {
    const version = String(candidate?.version ?? '')
    const expectedName = versionedManifestName(platform, version)
    if (!parseVersion(version)
      || !validManifest(candidate?.manifest, version)
      || candidate?.manifestUrl !== `${base}/${expectedName}`) continue
    entries.push(candidate)
  }

  const previousVersion = String(previousLatestManifest?.component?.dshVersion ?? '')
  if (entries.length === 0
    && previousVersion !== currentVersion
    && parseVersion(previousVersion)
    && validManifest(previousLatestManifest, previousVersion)) {
    manifests.set(previousVersion, previousLatestManifest)
    entries.push({
      version: previousVersion,
      manifestUrl: `${base}/${versionedManifestName(platform, previousVersion)}`,
      manifest: previousLatestManifest,
    })
  }

  entries.unshift({
    version: currentVersion,
    manifestUrl: `${base}/${versionedManifestName(platform, currentVersion)}`,
    manifest: currentManifest,
  })
  const unique = [...new Map(entries.map(entry => [entry.version, entry])).values()]
    .sort((left, right) => compareVersions(right.version, left.version))
    .slice(0, 5)
  const index = { schemaVersion: 1, channel, platform, versions: unique }
  const versionedManifestNames = []
  for (const [version, manifest] of manifests) {
    const name = versionedManifestName(platform, version)
    await writeFile(path.join(output, name), `${JSON.stringify(manifest)}\n`, 'utf8')
    versionedManifestNames.push(name)
  }
  await writeFile(path.join(output, `dsh-core-index-${platform}.json`), `${JSON.stringify(index)}\n`, 'utf8')
  return { index, versionedManifestNames }
}

async function readJson(filename, fallback = null) {
  return readFile(filename, 'utf8').then(JSON.parse, error => error?.code === 'ENOENT' ? fallback : Promise.reject(error))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [channel, platform, currentPath, previousIndexPath, previousLatestPath, output] = process.argv.slice(2)
  if (!output) {
    throw new Error('usage: node build-core-index.mjs <channel> <platform> <current-manifest> <previous-index> <previous-latest-manifest> <output>')
  }
  const result = await buildCoreIndex({
    channel,
    platform,
    currentManifest: await readJson(currentPath),
    previousIndex: await readJson(previousIndexPath, { schemaVersion: 1, versions: [] }),
    previousLatestManifest: await readJson(previousLatestPath, null),
    output: path.resolve(output),
  })
  process.stdout.write(`${JSON.stringify({ versions: result.index.versions.map(entry => entry.version), manifests: result.versionedManifestNames })}\n`)
}
