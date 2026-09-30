import { readFile, readdir, mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PLATFORMS = new Set(['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'])

function parseVersion(value) {
  const match = VERSION.exec(String(value ?? ''))
  if (!match) return null
  const prerelease = match[4]?.split('.') ?? null
  if (prerelease?.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null
  return { core: match.slice(1, 4).map(BigInt), prerelease }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1
  }
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0
  const length = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const leftId = a.prerelease[index]
    const rightId = b.prerelease[index]
    const leftNumeric = /^\d+$/.test(leftId)
    const rightNumeric = /^\d+$/.test(rightId)
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftId)
      const rightNumber = BigInt(rightId)
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
    } else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    else if (leftId !== rightId) return leftId < rightId ? -1 : 1
  }
  return a.prerelease.length - b.prerelease.length
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

function compatibleManifest(manifest, currentManifest) {
  return manifest?.platform === currentManifest?.platform
    && manifest?.portableVersion === currentManifest?.portableVersion
    && manifest?.requiredShellSchema === currentManifest?.requiredShellSchema
    && manifest?.requiredShellFingerprint === currentManifest?.requiredShellFingerprint
    && manifest?.targetRuntimeLayout === currentManifest?.targetRuntimeLayout
    && manifest?.component?.requiredNodeVersion === currentManifest?.component?.requiredNodeVersion
    && manifest?.component?.runtimeLayout === currentManifest?.component?.runtimeLayout
}

function versionedManifestName(platform, version) {
  return `dsh-core-update-${platform}-${version}.json`
}

function releaseBase(channel) {
  return `https://github.com/WSL043/DSH-Portable-Updates/releases/download/update-channel-core-${channel}`
}

export function isValidSemVer(value) {
  return parseVersion(value) !== null
}

function legacyManifestUrl(value, platform, version) {
  try {
    const url = new URL(value)
    return url.origin === 'https://github.com'
      && /^\/WSL043\/DSH-Portable-Updates\/releases\/download\/update-channel-core-(?:stable|candidate)\/$/.test(`${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}`)
      && url.pathname.endsWith(`/${versionedManifestName(platform, version)}`)
      && !url.search && !url.hash
  } catch { return false }
}

function channelAssetUrl(value, channel) {
  const url = new URL(value)
  if (url.origin !== 'https://github.com'
    || !/^\/WSL043\/DSH-Portable-Updates\/releases\/download\/update-channel-core-(?:stable|candidate)\/[^/]+$/.test(url.pathname)
    || url.search || url.hash) throw new Error('Core archive URL is outside the legacy channel tags.')
  return `${releaseBase(channel)}/${url.pathname.split('/').at(-1)}`
}

function canonicalManifest(manifest, channel) {
  return { ...manifest, releaseChannel: 'stable',
    component: { ...manifest.component, urls: manifest.component.urls.map(url => channelAssetUrl(url, channel)) } }
}

export async function buildCoreIndex({
  channel,
  platform,
  currentManifest,
  topThree,
  qualifiedVersions,
  previousIndex = null,
  previousIndexes = [],
  previousLatestManifest = null,
  output,
}) {
  if (!['stable', 'candidate'].includes(channel)) throw new Error(`Unsupported core channel: ${channel}`)
  if (!PLATFORMS.has(platform)) throw new Error(`Unsupported core platform: ${platform}`)
  if (!Array.isArray(topThree) || topThree.length !== 3 || new Set(topThree).size !== 3
    || topThree.some(version => !parseVersion(version))) throw new Error('A three-version official SemVer window is required.')
  const allowed = new Set(topThree)
  if (!Array.isArray(qualifiedVersions) || qualifiedVersions.some(version => !allowed.has(version))) {
    throw new Error('Qualified versions must be within the official SemVer window.')
  }
  const currentVersion = String(currentManifest?.component?.dshVersion ?? '')
  if (!parseVersion(currentVersion) || !validManifest(currentManifest, currentVersion)) {
    throw new Error('Current engine update manifest is invalid.')
  }
  if (!allowed.has(currentVersion) || !qualifiedVersions.includes(currentVersion)) {
    throw new Error(`Current engine version ${currentVersion} is not qualified inside the official SemVer window.`)
  }
  await mkdir(output, { recursive: true })
  const base = releaseBase(channel)
  const manifests = new Map()
  const entries = []

  for (const sourceIndex of [previousIndex, ...previousIndexes]) {
    for (const candidate of sourceIndex?.schemaVersion === 1 && Array.isArray(sourceIndex.versions)
      ? sourceIndex.versions
      : []) {
      const version = String(candidate?.version ?? '')
      if (!allowed.has(version) || !qualifiedVersions.includes(version)) continue
      const expectedName = versionedManifestName(platform, version)
      if (!parseVersion(version) || !legacyManifestUrl(candidate?.manifestUrl, platform, version)
        || !validManifest(candidate?.manifest, version)) continue
      const manifest = canonicalManifest(candidate.manifest, channel)
      if (!compatibleManifest(manifest, currentManifest)) continue
      manifests.set(version, manifest)
      entries.push({ version, manifestUrl: `${base}/${expectedName}`, manifest })
    }
  }

  const previousVersion = String(previousLatestManifest?.component?.dshVersion ?? '')
  if (entries.length === 0 && allowed.has(previousVersion) && qualifiedVersions.includes(previousVersion)
    && previousVersion !== currentVersion
    && validManifest(previousLatestManifest, previousVersion)
    && compatibleManifest(previousLatestManifest, currentManifest)) {
    const manifest = canonicalManifest(previousLatestManifest, channel)
    manifests.set(previousVersion, manifest)
    entries.push({
      version: previousVersion,
      manifestUrl: `${base}/${versionedManifestName(platform, previousVersion)}`,
      manifest,
    })
  }

  entries.unshift({
    version: currentVersion,
    manifestUrl: `${base}/${versionedManifestName(platform, currentVersion)}`,
    manifest: canonicalManifest(currentManifest, channel),
  })
  const unique = []
  const seenVersions = new Set()
  for (const entry of entries) {
    if (seenVersions.has(entry.version)) continue
    seenVersions.add(entry.version)
    unique.push(entry)
  }
  const bounded = unique
    .sort((left, right) => compareVersions(right.version, left.version))
    .filter(entry => allowed.has(entry.version))
    .slice(0, 3)
  for (const entry of bounded) manifests.set(entry.version, entry.manifest)
  const index = { schemaVersion: 1, channel, releaseChannel: channel, platform, versions: bounded }
  const versionedManifestNames = []
  const retainedNames = new Set(bounded.map(entry => versionedManifestName(platform, entry.version)))
  for (const item of await readdir(output, { withFileTypes: true })) {
    if (item.isFile() && item.name.startsWith(`dsh-core-update-${platform}-`)
      && item.name.endsWith('.json') && !retainedNames.has(item.name)) {
      await unlink(path.join(output, item.name))
    }
  }
  for (const [version, manifest] of manifests) {
    const name = versionedManifestName(platform, version)
    await writeFile(path.join(output, name), `${JSON.stringify(manifest)}\n`, 'utf8')
    versionedManifestNames.push(name)
  }
  await writeFile(path.join(output, `dsh-core-index-${platform}.json`), `${JSON.stringify(index)}\n`, 'utf8')
  // The automatic check and version picker must use the same compatible catalog.
  await writeFile(path.join(output, `dsh-core-update-${platform}.json`), `${JSON.stringify(bounded[0].manifest)}\n`, 'utf8')
  return { index, versionedManifestNames }
}

async function readJson(filename, fallback = null) {
  return readFile(filename, 'utf8').then(JSON.parse, error => error?.code === 'ENOENT' ? fallback : Promise.reject(error))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [channel, platform, currentPath, previousIndexPath, previousLatestPath, output, topThreeJson, qualifiedJson, otherIndexPath] = process.argv.slice(2)
  if (!output) {
    throw new Error('usage: node build-core-index.mjs <channel> <platform> <current-manifest> <previous-index> <previous-latest-manifest> <output> <top-three-json> <qualified-versions-json> <other-channel-index>')
  }
  const result = await buildCoreIndex({
    channel,
    platform,
    currentManifest: await readJson(currentPath),
    topThree: JSON.parse(topThreeJson ?? 'null'),
    qualifiedVersions: JSON.parse(qualifiedJson ?? 'null'),
    previousIndex: await readJson(previousIndexPath, { schemaVersion: 1, versions: [] }),
    previousIndexes: [await readJson(otherIndexPath, { schemaVersion: 1, versions: [] })],
    previousLatestManifest: await readJson(previousLatestPath, null),
    output: path.resolve(output),
  })
  process.stdout.write(`${JSON.stringify({ versions: result.index.versions.map(entry => entry.version), manifests: result.versionedManifestNames })}\n`)
}
