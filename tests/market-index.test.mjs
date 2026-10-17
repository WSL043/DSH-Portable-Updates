import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex, buildQuery, displayTitle, githubTarget, manifestIcon, pinnedFirst, npmIcon, resolveNpm, readManifest, readResolved, resolveGithub, targetKey } from '../scripts/build-market-index.mjs'

const SHA = 'a'.repeat(40)
const catalog = (plugins) => ({ updated: '2026-10-16', categories: { tools: { en: 'Tools', zh: '工具' } }, plugins })
const base = { owner: 'someone', category: 'tools', description: { en: 'Does a thing', zh: '做一件事' }, stars: 3, downloads: 10, added: '2026-09-01', page: 'https://awesome-dsh-plugin.com/p/someone/x/' }

test('npm, release-tarball, git and sub-directory entries become the four source shapes', () => {
  const plugins = [
    { ...base, name: 'npm-plugin', npm: '@scope/npm-plugin', version: '1.2.3', url: 'https://github.com/someone/npm-plugin' },
    { ...base, name: 'tar-plugin', npm: null, url: 'https://github.com/someone/tar-plugin', tarball: 'https://github.com/someone/tar-plugin/releases/download/v0.2.3/someone-tar-plugin-0.2.3.tgz' },
    { ...base, name: 'git-plugin', npm: null, url: 'https://github.com/someone/git-plugin' },
    { ...base, name: 'mono-plugin', npm: null, url: 'https://github.com/someone/mono/tree/main/packages/mono-plugin' },
  ]
  const resolved = {
    [targetKey(githubTarget(plugins[1]))]: { tag: { oid: SHA, manifest: { name: '@someone/tar-plugin', version: '0.2.3', engines: '^0.2.0' } } },
    [targetKey(githubTarget(plugins[2]))]: { head: SHA, headManifest: { name: 'git-plugin', version: '0.5.0' } },
    [targetKey(githubTarget(plugins[3]))]: { head: SHA, headManifest: { name: 'mono-plugin', version: '1.0.0' } },
  }
  const { index, report } = buildIndex(catalog(plugins), resolved, 1)
  assert.equal(index.format, 1)
  assert.deepEqual(report.counts, { npm: 1, tarball: 1, git: 2 })
  const byName = Object.fromEntries(index.plugins.map(plugin => [plugin.name, plugin.versions[0]]))
  assert.deepEqual(byName['@scope/npm-plugin'].source, { type: 'npm' })
  assert.deepEqual(byName['@someone/tar-plugin'].source, { type: 'tarball', url: plugins[1].tarball })
  assert.deepEqual(byName['@someone/tar-plugin'].engines, { dsh: '^0.2.0' })
  assert.deepEqual(byName['git-plugin'].source, { type: 'git', url: 'https://github.com/someone/git-plugin', commit: SHA })
  assert.deepEqual(byName['mono-plugin'].source, { type: 'git', url: 'https://github.com/someone/mono', commit: SHA, path: 'packages/mono-plugin' })
  assert.equal(byName['git-plugin'].publishTimestamp, Math.floor(Date.parse('2026-09-01') / 1000))
  assert.deepEqual(index.metadata.categories.tools.title, { en: 'Tools', zh: '工具' })
  assert.deepEqual(index.plugins[0].metadata.sortKeys, { stars: 3, downloads: 10 })
})

test('what cannot be represented or resolved is skipped and counted, never guessed', () => {
  const plugins = [
    { ...base, name: 'bad-name', npm: 'Bad_Name', version: '1.0.0' },
    { ...base, name: 'no-version', npm: 'no-version', version: 'latest' },
    { ...base, name: 'elsewhere', npm: null, url: 'https://gitlab.com/someone/elsewhere' },
    { ...base, name: 'no-lookup', npm: null, url: 'https://github.com/someone/no-lookup' },
    { ...base, name: 'no-manifest', npm: null, url: 'https://github.com/someone/no-manifest' },
    { ...base, name: 'no-commit', npm: null, url: 'https://github.com/someone/no-commit' },
    { ...base, name: 'bad-tag', npm: null, url: 'https://github.com/someone/bad-tag', tarball: 'https://github.com/someone/bad-tag/releases/download/v1/x-1.0.0.tgz' },
  ]
  const resolved = {
    [targetKey(githubTarget(plugins[4]))]: { head: SHA, headManifest: null },
    [targetKey(githubTarget(plugins[5]))]: { head: 'nope', headManifest: { name: 'no-commit', version: '1.0.0' } },
    [targetKey(githubTarget(plugins[6]))]: { tag: { oid: SHA, manifest: null } },
  }
  const { index, report } = buildIndex(catalog(plugins), resolved, 1)
  assert.equal(index.plugins.length, 0)
  assert.deepEqual(report.skips, {
    'npm name not valid for the index': 1,
    'npm entry without a valid version': 1,
    'not hosted on GitHub and not on npm': 1,
    'GitHub lookup unavailable': 1,
    'repository has no readable package.json': 1,
    'no default branch commit': 1,
    'release tag has no readable package.json': 1,
  })
})

test('a package name the catalog lists twice goes to the most downloaded entry', () => {
  const plugins = [
    { ...base, name: 'copy', owner: 'small', npm: 'dsh-same', version: '1.0.0', downloads: 5 },
    { ...base, name: 'original', owner: 'big', npm: 'dsh-same', version: '2.0.0', downloads: 500 },
  ]
  const { index, report } = buildIndex(catalog(plugins), {}, 1)
  assert.equal(index.plugins.length, 1)
  assert.equal(index.plugins[0].author, 'big')
  assert.equal(report.skips['duplicate package name'], 1)
})

test('titles drop the #suffix, and manifests are read strictly', () => {
  assert.equal(displayTitle('dsh-codex-pet#dsh-codex-pet'), 'dsh-codex-pet')
  assert.equal(displayTitle('plain'), 'plain')
  assert.deepEqual(readManifest('{"name":"a","version":"1.0.0","engines":{"dsh":"^0.2.0"}}'), { name: 'a', version: '1.0.0', engines: '^0.2.0' })
  assert.equal(readManifest('{"name":"Bad","version":"1.0.0"}'), null)
  assert.equal(readManifest('{"name":"a","version":"v1"}'), null)
  assert.equal(readManifest('not json'), null)
})

test('GitHub lookups ask for the default branch or the tag, and for the package.json of the right directory', async () => {
  const targets = [
    githubTarget({ url: 'https://github.com/o/r' }),
    githubTarget({ url: 'https://github.com/o/m/tree/main/packages/p' }),
    githubTarget({ url: 'https://github.com/o/t', tarball: 'https://github.com/o/t/releases/download/v1.0.0/t-1.0.0.tgz' }),
  ]
  const query = buildQuery(targets)
  assert.ok(query.includes('object(expression: "HEAD") { oid }'))
  assert.ok(query.includes('"HEAD:package.json"'))
  assert.ok(query.includes('"HEAD:packages/p/package.json"'))
  assert.ok(query.includes('object(expression: "v1.0.0") { oid }') && query.includes('"v1.0.0:package.json"'))
  assert.deepEqual(readResolved(targets[0], { commit: { oid: SHA }, manifest: { text: '{"name":"r","version":"1.0.0"}' } }), { head: SHA, headManifest: { name: 'r', version: '1.0.0' } })
  assert.deepEqual(readResolved(targets[2], { commit: { oid: SHA }, manifest: null }), { tag: { oid: SHA, manifest: undefined } })
  assert.deepEqual(readResolved(targets[0], null), {})
  assert.equal(githubTarget({ url: 'https://github.com/o/m/tree/main/../x' }), null)
})

test('a request that returns no data fails, while a missing repository only drops that entry', async () => {
  const plugins = [{ ...base, name: 'gone', npm: null, url: 'https://github.com/o/gone' }, { ...base, name: 'here', npm: null, url: 'https://github.com/o/here' }]
  const ok = async () => new Response(JSON.stringify({ data: { r0: null, r1: { commit: { oid: SHA }, manifest: { text: '{"name":"here","version":"1.0.0"}' } } }, errors: [{ message: 'not found' }] }))
  const resolved = await resolveGithub({ plugins }, 'token', ok)
  const { index } = buildIndex(catalog(plugins), resolved, 1)
  assert.deepEqual(index.plugins.map(plugin => plugin.name), ['here'])
  await assert.rejects(resolveGithub({ plugins }, 'token', async () => new Response(JSON.stringify({ data: null, errors: [{ message: 'bad credentials' }] }))), /no data/u)
  await assert.rejects(resolveGithub({ plugins }, 'token', async () => new Response('x', { status: 502 })), /HTTP 502/u)
})

test('a plugin shows the icon its own package.json declares, pinned to the commit it was read at; none declared means none listed', () => {
  const target = { owner: 'someone', repo: 'mono', path: 'packages/p' }
  assert.equal(manifestIcon('./assets/icon.svg', target, SHA), `https://cdn.jsdelivr.net/gh/someone/mono@${SHA}/packages/p/assets/icon.svg`)
  assert.equal(manifestIcon('icon.png', { ...target, path: null }, SHA), `https://cdn.jsdelivr.net/gh/someone/mono@${SHA}/icon.png`)
  assert.equal(manifestIcon('https://example.com/i.png', target, SHA), 'https://example.com/i.png')
  assert.equal(manifestIcon('data:image/svg+xml;base64,PHN2Zy8+', target, SHA), 'data:image/svg+xml;base64,PHN2Zy8+')
  for (const bad of [undefined, '', '../x.svg', './a/../../x.svg', 'http://example.com/i.png', 'data:text/html;base64,AAAA', 'a b.svg']) assert.equal(manifestIcon(bad, target, SHA), undefined, String(bad))
  assert.equal(manifestIcon('icon.svg', target, 'main'), undefined, 'a branch name is not a pin')
  const plugins = [
    { ...base, name: 'with', npm: 'with-icon', version: '1.0.0', url: 'https://github.com/someone/with' },
    { ...base, name: 'without', npm: 'no-icon', version: '1.0.0', url: 'https://github.com/someone/without' },
    { ...base, name: 'other', npm: 'wanted', version: '1.0.0', url: 'https://github.com/someone/other' },
    { ...base, name: 'gitp', npm: null, url: 'https://github.com/someone/gitp' },
  ]
  const resolved = {
    [targetKey(githubTarget(plugins[0]))]: { head: SHA, headManifest: { name: 'with-icon', version: '1.0.0', icon: './icon.svg' } },
    [targetKey(githubTarget(plugins[1]))]: { head: SHA, headManifest: { name: 'no-icon', version: '1.0.0' } },
    [targetKey(githubTarget(plugins[2]))]: { head: SHA, headManifest: { name: 'unrelated', version: '1.0.0', icon: 'icon.svg' } },
    [targetKey(githubTarget(plugins[3]))]: { head: SHA, headManifest: { name: 'gitp', version: '1.0.0', icon: 'icon.png' } },
  }
  const { index } = buildIndex(catalog(plugins), resolved, 1)
  const byName = Object.fromEntries(index.plugins.map(plugin => [plugin.name, plugin.icon]))
  assert.equal(byName['with-icon'], undefined, 'an npm plugin takes its icon from the published package, not from the repository head')
  assert.equal(byName['no-icon'], undefined)
  assert.equal(byName.wanted, undefined, 'a different package in the same repository does not lend its icon')
  assert.equal(byName.gitp, `https://cdn.jsdelivr.net/gh/someone/gitp@${SHA}/icon.png`)
  assert.equal(readManifest(JSON.stringify({ name: 'a', version: '1.0.0', icon: './i.svg' })).icon, './i.svg')
})

test('an npm plugin is listed at the version npm calls latest, with its own icon, not at the catalog snapshot', async () => {
  const plugin = { ...base, name: 'dsh-codex-subscription', npm: 'dsh-codex-subscription', version: '2.7.1', url: 'https://github.com/someone/sub' }
  const registry = {
    'dsh-codex-subscription': { name: 'dsh-codex-subscription', version: '3.0.0', icon: './icon-subscription.webp', engines: { node: '>=24', dsh: '^0.2.0' } },
    '@s/gone': { name: '@s/gone', version: '1.0.0', deprecated: 'use another' },
  }
  const calls = []
  const fetcher = async url => {
    calls.push(String(url))
    const name = decodeURIComponent(String(url).replace('https://registry.npmjs.org/', '').replace(/\/latest$/, ''))
    return registry[name] ? { ok: true, json: async () => registry[name] } : { ok: false, json: async () => ({}) }
  }
  const catalogPlugins = [plugin, { ...base, name: 'gone', npm: '@s/gone', version: '1.0.0', url: 'https://github.com/someone/gone' }, { ...base, name: 'missing', npm: 'not-on-npm', version: '0.1.0', url: 'https://github.com/someone/m' }]
  const latest = await resolveNpm(catalog(catalogPlugins), fetcher)
  assert.deepEqual(Object.keys(latest), ['dsh-codex-subscription'], 'a deprecated or unreachable package keeps the catalog data')
  assert.ok(calls.includes('https://registry.npmjs.org/@s%2Fgone/latest'), 'scoped names are encoded')
  const { index } = buildIndex(catalog(catalogPlugins), {}, 1, latest)
  const byName = Object.fromEntries(index.plugins.map(p => [p.name, p]))
  assert.equal(byName['dsh-codex-subscription'].versions[0].version, '3.0.0')
  assert.deepEqual(byName['dsh-codex-subscription'].versions[0].engines, { dsh: '^0.2.0' })
  assert.equal(byName['dsh-codex-subscription'].icon, 'https://cdn.jsdelivr.net/npm/dsh-codex-subscription@3.0.0/icon-subscription.webp')
  assert.equal(byName['@s/gone'].versions[0].version, '1.0.0')
  assert.equal(byName['not-on-npm'].versions[0].version, '0.1.0')
  assert.equal(npmIcon('../x.png', 'a', '1.0.0'), undefined)
  assert.equal(npmIcon('https://example.com/i.png', 'a', '1.0.0'), 'https://example.com/i.png')
})

test('the plugin DSH-Portable maintains leads the default order, the rest keep theirs', () => {
  const list = [{ name: 'x' }, { name: 'dsh-codex-subscription' }, { name: 'y' }]
  assert.deepEqual(pinnedFirst(list).map(plugin => plugin.name), ['dsh-codex-subscription', 'x', 'y'])
  assert.deepEqual(pinnedFirst([{ name: 'a' }, { name: 'b' }]).map(plugin => plugin.name), ['a', 'b'])
})
