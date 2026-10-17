#!/usr/bin/env node
// Builds the plugin index that DSH-Portable pre-installs into the official experimental plugin market.
//
// Input is the Awesome DSH catalog (https://awesome-dsh-plugin.com/plugins.json). Output is one "format 1" index file:
//   - npm entries            -> { type: 'npm' }
//   - GitHub release tarball -> { type: 'tarball', url }   (a third source type Portable adds to the official market)
//   - GitHub-only entries    -> { type: 'git', url, commit } with the commit resolved from the default branch HEAD
// A GitHub-sourced entry takes its package name, version and `engines.dsh` from the package.json at that exact commit
// (or release tag); an entry whose package.json cannot be read or is not valid is skipped and counted, never guessed.
//
//   node scripts/build-market-index.mjs <out.json> [--catalog <plugins.json>] [--report <report.json>]
// GITHUB_TOKEN (or GH_TOKEN) is required to resolve GitHub entries; without one only npm entries are produced.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const LOCALE = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u
// A plugin kept in a sub-directory of a repository: the catalog installs it as github:owner/repo#path:/dir from HEAD.
const GITHUB_TREE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/[^/]+\/((?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+)\/?$/u
const TARBALL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download\/([^/]+)\/[^/]+\.(?:tgz|tar\.gz)$/iu
const BATCH = 80

function localized(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (value !== null && typeof value === 'object') {
    const result = {}
    for (const [key, text] of Object.entries(value)) {
      if (typeof text === 'string' && text.trim() !== '' && LOCALE.test(key)) result[key] = text
    }
    if (result.en !== undefined) return result
    const any = Object.values(result)[0]
    if (any !== undefined) return { en: any, ...result }
  }
  return undefined
}

/** The catalog name with the `#suffix` some entries carry for disambiguation removed. */
export function displayTitle(name) {
  const text = String(name ?? '')
  const cut = text.indexOf('#')
  return (cut > 0 ? text.slice(0, cut) : text).trim()
}

export function targetKey(target) {
  return `${target.owner}/${target.repo}#${target.ref ?? ''}#${target.path ?? ''}`
}

/** Where GitHub should be asked about an entry, or null for an entry that is not hosted there. */
export function githubTarget(plugin) {
  if (typeof plugin.tarball === 'string') {
    const match = TARBALL.exec(plugin.tarball)
    if (match) return { owner: match[1], repo: match[2], ref: match[3], path: null, tarball: plugin.tarball }
  }
  const tree = GITHUB_TREE.exec(plugin.url ?? '')
  if (tree && !tree[3].split('/').some(segment => segment === '.' || segment === '..')) return { owner: tree[1], repo: tree[2], ref: null, path: tree[3], tarball: null }
  const match = GITHUB_REPO.exec(plugin.url ?? '')
  return match ? { owner: match[1], repo: match[2], ref: null, path: null, tarball: null } : null
}

export function readManifest(text) {
  try {
    const manifest = JSON.parse(text)
    if (typeof manifest.name !== 'string' || !NAME.test(manifest.name) || manifest.name.length > 214) return null
    if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) return null
    const range = manifest.engines?.dsh
    return { name: manifest.name, version: manifest.version, ...(typeof range === 'string' && range.trim() !== '' ? { engines: range } : {}) }
  } catch {
    return null
  }
}

/**
 * Pure builder. `resolved` maps `owner/repo` to what GitHub said: { head, headManifest, tag: { oid, manifest } } (any may be absent).
 */
export function buildIndex(catalog, resolved = {}, now = Math.floor(Date.now() / 1000)) {
  const categories = {}
  for (const [id, title] of Object.entries(catalog.categories ?? {})) {
    const text = localized(title)
    if (text !== undefined) categories[id] = { title: text }
  }
  const fallbackTimestamp = Math.floor(Date.parse(catalog.updated ?? '') / 1000) || now
  const skips = {}
  const skip = reason => { skips[reason] = (skips[reason] ?? 0) + 1 }
  const seen = new Set()
  const plugins = []
  const counts = { npm: 0, tarball: 0, git: 0 }

  // The most downloaded entry keeps a package name that the catalog lists more than once.
  const ordered = [...(catalog.plugins ?? [])].sort((left, right) => (right.downloads ?? 0) - (left.downloads ?? 0) || (right.stars ?? 0) - (left.stars ?? 0))
  for (const plugin of ordered) {
    let name
    let version
    let engines
    let source
    let kind
    if (plugin.npm) {
      if (!NAME.test(plugin.npm) || plugin.npm.length > 214) { skip('npm name not valid for the index'); continue }
      if (typeof plugin.version !== 'string' || !SEMVER.test(plugin.version)) { skip('npm entry without a valid version'); continue }
      name = plugin.npm; version = plugin.version; source = { type: 'npm' }; kind = 'npm'
    } else {
      const target = githubTarget(plugin)
      if (target === null) { skip('not hosted on GitHub and not on npm'); continue }
      const info = resolved[targetKey(target)]
      if (info === undefined) { skip('GitHub lookup unavailable'); continue }
      if (target.tarball !== null && target.ref !== null) {
        const manifest = info.tag?.manifest
        if (manifest === undefined || manifest === null) { skip('release tag has no readable package.json'); continue }
        name = manifest.name; version = manifest.version; engines = manifest.engines
        source = { type: 'tarball', url: target.tarball }; kind = 'tarball'
      } else {
        if (typeof info.head !== 'string' || !/^[0-9a-f]{40}$/u.test(info.head)) { skip('no default branch commit'); continue }
        const manifest = info.headManifest
        if (manifest === undefined || manifest === null) { skip('repository has no readable package.json'); continue }
        name = manifest.name; version = manifest.version; engines = manifest.engines
        source = { type: 'git', url: `https://github.com/${target.owner}/${target.repo}`, commit: info.head, ...(target.path === null ? {} : { path: target.path }) }; kind = 'git'
      }
    }
    if (seen.has(name)) { skip('duplicate package name'); continue }
    seen.add(name)
    const added = Math.floor(Date.parse(plugin.added) / 1000)
    const description = localized(plugin.description)
    const homepage = typeof plugin.page === 'string' && /^https?:\/\//u.test(plugin.page) ? plugin.page : undefined
    plugins.push({
      name,
      title: displayTitle(plugin.name) || name,
      ...(description === undefined ? {} : { description }),
      ...(plugin.owner ? { author: String(plugin.owner) } : {}),
      ...(homepage === undefined ? {} : { homepage }),
      ...(/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+$/u.test(plugin.url ?? '') ? { repository: { url: plugin.url } } : {}),
      metadata: {
        ...(plugin.category && categories[plugin.category] ? { category: plugin.category } : {}),
        keywords: Array.isArray(plugin.capabilities) ? plugin.capabilities.filter(item => typeof item === 'string') : [],
        sortKeys: { stars: plugin.stars ?? 0, downloads: plugin.downloads ?? 0 },
      },
      versions: [{
        version,
        publishTimestamp: Number.isFinite(added) ? added : fallbackTimestamp,
        source,
        ...(engines === undefined ? {} : { engines: { dsh: engines } }),
      }],
    })
    counts[kind] += 1
  }

  return {
    index: {
      format: 1,
      title: { en: 'Awesome DSH Plugins', zh: 'Awesome DSH 插件' },
      description: { en: 'Community catalog from awesome-dsh-plugin.com, regenerated daily by DSH-Portable.', zh: '来自 awesome-dsh-plugin.com 的社区插件目录，由 DSH-Portable 每天重新生成。' },
      metadata: {
        categories,
        sortKeys: {
          stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
          downloads: { title: { en: 'Downloads (30 days)', zh: '30 天下载量' }, order: 'desc' },
        },
      },
      plugins,
    },
    report: { catalogEntries: (catalog.plugins ?? []).length, included: plugins.length, counts, skips },
  }
}

function aliasFor(index) { return `r${String(index)}` }

/** One GraphQL request per batch: default-branch commit and package.json, and the tagged commit and package.json when asked. */
export function buildQuery(targets) {
  const fields = targets.map((target, index) => {
    const ref = target.ref ?? 'HEAD'
    const manifest = `${ref}:${target.path === null ? '' : `${target.path}/`}package.json`
    return `${aliasFor(index)}: repository(owner: ${JSON.stringify(target.owner)}, name: ${JSON.stringify(target.repo)}) { commit: object(expression: ${JSON.stringify(ref)}) { oid } manifest: object(expression: ${JSON.stringify(manifest)}) { ... on Blob { text } } }`
  })
  return `query { ${fields.join(' ')} }`
}

export function readResolved(target, node) {
  if (node === null || node === undefined) return {}
  const manifest = node.manifest?.text === undefined ? undefined : readManifest(node.manifest.text)
  const oid = node.commit?.oid
  return target.ref === null ? { head: oid, headManifest: manifest } : { tag: { oid, manifest } }
}

export async function resolveGithub(catalog, token, fetcher = fetch) {
  const wanted = new Map()
  for (const plugin of catalog.plugins ?? []) {
    if (plugin.npm) continue
    const target = githubTarget(plugin)
    if (target === null) continue
    wanted.set(targetKey(target), target)
  }
  const targets = [...wanted.values()]
  const resolved = {}
  for (let offset = 0; offset < targets.length; offset += BATCH) {
    const batch = targets.slice(offset, offset + BATCH)
    const response = await fetcher('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'dsh-portable-market-index' },
      body: JSON.stringify({ query: buildQuery(batch) }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`GitHub GraphQL returned HTTP ${String(response.status)}`)
    const body = await response.json()
    // Missing repositories come back as per-alias errors with partial data; only a request that returned no data at all is fatal.
    if (body.data === null || body.data === undefined) throw new Error(`GitHub GraphQL returned no data: ${JSON.stringify(body.errors ?? []).slice(0, 300)}`)
    batch.forEach((target, index) => { resolved[targetKey(target)] = readResolved(target, body.data[aliasFor(index)]) })
  }
  return resolved
}

async function main(argv) {
  const out = argv[0]
  if (!out || out.startsWith('--')) throw new Error('usage: build-market-index.mjs <out.json> [--catalog <plugins.json>] [--report <report.json>]')
  const option = name => { const at = argv.indexOf(name); return at === -1 ? null : argv[at + 1] }
  const catalogPath = option('--catalog')
  const catalog = catalogPath === null
    ? await (async () => { const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) }); if (!response.ok) throw new Error(`catalog returned HTTP ${String(response.status)}`); return response.json() })()
    : JSON.parse(await readFile(catalogPath, 'utf8'))
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const resolved = token ? await resolveGithub(catalog, token) : {}
  const { index, report } = buildIndex(catalog, resolved)
  if (index.plugins.length < 1000) throw new Error(`refusing to write an index with only ${String(index.plugins.length)} plugins`)
  await writeFile(out, `${JSON.stringify(index)}\n`, 'utf8')
  const reportPath = option('--report')
  if (reportPath !== null) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
