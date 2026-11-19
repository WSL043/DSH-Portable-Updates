// Discover new installable npm plugins from GitHub and the supplementary market.
const GITHUB_SEARCH = 'https://api.github.com/search/repositories'
const NPM = 'https://registry.npmjs.org'
const OPEN_INDEX = 'https://dshopen.org/index.json'
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u
const DIRECTORY = /^(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/u

export function isDshBundle(manifest) {
  const patch = manifest?.dsh?.bundle?.patch
  const files = Array.isArray(patch) ? patch : [patch]
  return files.length > 0 && files.every(file => typeof file === 'string' && file.trim() !== '')
}

async function readJson(url, fetcher, headers, signal) {
  const response = await fetcher(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + new URL(url).hostname)
  return response.json()
}

export async function discoverGithub(token, fetcher = fetch) {
  const headers = { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'dsh-portable-market-index' }
  const lists = await Promise.all(['stars', 'updated'].map(async sort => {
    const url = new URL(GITHUB_SEARCH)
    url.search = new URLSearchParams({ q: 'topic:dsh-plugin archived:false fork:false', sort, per_page: '100' }).toString()
    const result = await readJson(url, fetcher, headers)
    if (!Array.isArray(result.items)) throw new Error('GitHub discovery returned an invalid result')
    return result.items
  }))
  const repos = new Map()
  for (const repo of lists.flat()) {
    if (!REPO.test(repo.html_url)) continue
    repos.set(repo.html_url, { url: repo.html_url, name: repo.name, owner: repo.owner?.login, stars: repo.stargazers_count })
  }
  return [...repos.values()]
}

export async function discoverSupplement(fetcher = fetch) {
  const index = await readJson(OPEN_INDEX, fetcher)
  if (index.format !== 1 || !Array.isArray(index.plugins) || index.plugins.length === 0) throw new Error('Supplementary market returned an invalid index')
  return index.plugins.filter(plugin => typeof plugin?.name === 'string' &&
    Array.isArray(plugin.versions) && plugin.versions.some(version => version?.source?.type === 'npm' &&
      (version.source.registry === undefined || version.source.registry === NPM || version.source.registry === NPM + '/')))
}

function npmRepository(manifest) {
  const repository = manifest.repository
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string') return null
  const normalized = raw.replace(/^git\+/u, '').replace(/^github:/u, 'https://github.com/').replace(/^git:\/\/github\.com\//u, 'https://github.com/')
  const match = REPO.exec(normalized)
  if (!match) return null
  const url = 'https://github.com/' + match[1]
  const directory = typeof repository?.directory === 'string' ? repository.directory.replace(/^\.\//u, '').replace(/\/$/u, '') : ''
  if (!directory) return { url }
  if (!DIRECTORY.test(directory) || directory.split('/').some(part => part === '.' || part === '..')) return null
  return { url, directory }
}

export function readPublication(packument, version, now) {
  const time = packument?.time
  const raw = time && Object.hasOwn(time, version) ? time[version] : undefined
  const publishedAt = typeof raw === 'string' ? Math.floor(Date.parse(raw) / 1000) : NaN
  return publishedAt > 0 && publishedAt <= now ? publishedAt : undefined
}

export function readDiscoveredRelease(name, packument, repo, now) {
  const version = packument?.['dist-tags']?.latest
  if (packument?.name !== name || typeof version !== 'string' || !VERSION.test(version)) return null
  const manifest = packument.versions?.[version]
  if (manifest?.name !== name || manifest.version !== version || manifest.deprecated || !isDshBundle(manifest)) return null
  const dist = manifest.dist
  if (typeof dist?.tarball !== 'string' || !dist.tarball.startsWith(NPM + '/') ||
      typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(dist.integrity)) return null
  const repository = npmRepository(manifest)
  if (repo && (!repository || repository.directory || repository.url.toLowerCase() !== repo.url.toLowerCase())) return null
  const publishedAt = readPublication(packument, version, now)
  if (publishedAt === undefined) return null
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
  const owner = repository?.url.split('/')[3] ?? author
  const range = manifest.engines?.dsh
  return {
    plugin: { name, npm: name, version, description: manifest.description, owner,
      ...(repository && { url: repository.directory ? repository.url + '/tree/HEAD/' + repository.directory : repository.url }),
      ...(Number.isSafeInteger(repo?.stars) && repo.stars >= 0 && { stars: repo.stars }) },
    release: { version, ...(typeof range === 'string' && range.trim() !== '' && { engines: range }), icon: manifest.icon },
    publishedAt,
  }
}

/** Use one bounded registry pool for newly found packages and exact dates missing from the bulk index. */
export async function verifyDiscoveries(candidates, missingDates, fetcher = fetch, now = Math.floor(Date.now() / 1000)) {
  const budget = AbortSignal.timeout(90_000)
  const allNames = [...new Set([...candidates.keys(), ...missingDates.keys()])]
  const additions = new Map()
  const dates = new Map()
  const failures = new Set()
  let next = 0
  async function worker() {
    while (!budget.aborted && next < allNames.length) {
      const name = allNames[next++]
      if (!NAME.test(name) || name.length > 214) continue
      try {
        const doc = await readJson(NPM + '/' + encodeURIComponent(name), fetcher, { accept: 'application/json' }, budget)
        if (doc?.name !== name) continue
        const candidate = candidates.get(name)
        if (candidate) {
          const result = readDiscoveredRelease(name, doc, candidate.repo, now)
          if (result) additions.set(name, result)
        }
        const version = missingDates.get(name)
        if (version) {
          const time = readPublication(doc, version, now)
          if (time !== undefined) dates.set(name + '@' + version, time)
        }
      } catch (error) {
        if (!String(error.message).startsWith('HTTP 404 ')) failures.add(name)
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  for (const name of allNames.slice(next)) failures.add(name)
  return { additions, dates, failures }
}
