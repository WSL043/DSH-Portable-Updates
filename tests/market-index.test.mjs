import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex, buildQuery, displayTitle, githubTarget, iconFor, readManifest, readResolved, resolveGithub, targetKey } from '../scripts/build-market-index.mjs'

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

test('each plugin gets the avatar of the GitHub account that publishes it, because the official page shows only an icon', () => {
  assert.equal(iconFor({ url: 'https://github.com/someone/x' }), 'https://github.com/someone.png?size=96')
  assert.equal(iconFor({ url: 'https://github.com/some-one/mono/tree/main/packages/p' }), 'https://github.com/some-one.png?size=96')
  assert.equal(iconFor({ url: 'https://gitlab.com/someone/x' }), undefined)
  assert.equal(iconFor({}), undefined)
  const { index } = buildIndex(catalog([{ ...base, name: 'n', npm: 'n-plugin', version: '1.0.0', url: 'https://github.com/someone/n' }]), {}, 1)
  assert.equal(index.plugins[0].icon, 'https://github.com/someone.png?size=96')
})
