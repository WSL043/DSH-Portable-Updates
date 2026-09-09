import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function bindMarketHost(manifest, plan) {
  assert.equal(manifest.name, '@wsl043/dsh-portable-plugin-market')
  const peer = '@deepseek-ai/dsh-settings'
  assert.equal(typeof manifest.peerDependencies?.[peer], 'string')
  const host = plan.members.dsh.find(member => member.name === peer)
  assert.ok(host?.version, 'official release must include the settings host')
  // This is an exact qualification input, not a claim that future versions work.
  // npm excludes a new prerelease tuple even from an otherwise broad peer range.
  return { ...manifest, peerDependencies: { ...manifest.peerDependencies, [peer]: host.version } }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [root, planFile] = process.argv.slice(2)
  const filename = path.join(root, 'app/vendor/dsh-portable-plugin-market/package.json')
  const original = JSON.parse(await readFile(filename, 'utf8'))
  const plan = JSON.parse(await readFile(planFile, 'utf8'))
  const next = bindMarketHost(original, plan)
  await writeFile(filename, JSON.stringify(next, null, 2) + '\n')
  const evidence = { sourceCommit: plan.sourceCommit, package: next.name,
    peer: '@deepseek-ai/dsh-settings', before: original.peerDependencies['@deepseek-ai/dsh-settings'],
    qualificationVersion: next.peerDependencies['@deepseek-ai/dsh-settings'] }
  await writeFile('market-host-binding.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
}
