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
  const peerDependencies = { ...manifest.peerDependencies, [peer]: host.version }
  // The same applies to the official cordis host: a prerelease such as 4.0.5-alpha.1 falls outside ^4.0.1,
  // so a release that ships one is qualified against that exact version. Stable cordis keeps the range.
  const cordis = plan.members.vendor?.find(member => member.name === '@deepseek-ai/cordis')
  if (cordis?.version?.includes('-') && typeof peerDependencies['@deepseek-ai/cordis'] === 'string') {
    peerDependencies['@deepseek-ai/cordis'] = cordis.version
  }
  return { ...manifest, peerDependencies }
}

export function bindReviewedOfficeParser(manifest) {
  const office = '@deepseek-ai/libreoffice-kit@0.2.3'
  if (Object.hasOwn(manifest.overrides ?? {}, office)) return manifest
  // The released shell stages new cores with its original manifest. Carry the
  // existing ZIP64 fix to the newly reviewed Office package (GHSA-px8p-9vwx-vf98).
  return { ...manifest, overrides: { ...manifest.overrides, [office]: { fflate: '0.8.3' } } }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [root, planFile] = process.argv.slice(2)
  const filename = path.join(root, 'app/vendor/dsh-portable-plugin-market/package.json')
  const runtimeFile = path.join(root, 'app/package.json')
  const original = JSON.parse(await readFile(filename, 'utf8'))
  const plan = JSON.parse(await readFile(planFile, 'utf8'))
  const runtime = bindReviewedOfficeParser(JSON.parse(await readFile(runtimeFile, 'utf8')))
  const next = bindMarketHost(original, plan)
  await writeFile(runtimeFile, JSON.stringify(runtime, null, 2) + '\n')
  await writeFile(filename, JSON.stringify(next, null, 2) + '\n')
  const evidence = { sourceCommit: plan.sourceCommit, package: next.name,
    peer: '@deepseek-ai/dsh-settings', before: original.peerDependencies['@deepseek-ai/dsh-settings'],
    qualificationVersion: next.peerDependencies['@deepseek-ai/dsh-settings'],
    cordisBefore: original.peerDependencies['@deepseek-ai/cordis'], cordisQualification: next.peerDependencies['@deepseek-ai/cordis'] }
  await writeFile('market-host-binding.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
}
