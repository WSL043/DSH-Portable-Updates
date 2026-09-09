import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function resolvePackedMembers(root, lock) {
  const actualCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  assert.match(lock.dsh.reviewedCommit, /^[a-f0-9]{40}$/)
  assert.equal(actualCommit, lock.dsh.reviewedCommit, 'official checkout must match the immutable source lock')
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/)
  const { releaseFamily } = await import(pathToFileURL(path.join(root, 'scripts/release/families.ts')))
  // Use the very same membership rules as release:pack, including private-package
  // exclusions. Directory counts are not a publishable package manifest.
  const members = Object.fromEntries(['dsh', 'vendor'].map(family => [family,
    releaseFamily(family).members(root).map(({ name, version, directory }) => ({ name, version, directory })),
  ]))
  assert.ok(members.dsh.length && members.vendor.length, 'official release families must not be empty')
  assert.equal(members.dsh.find(member => member.name === '@deepseek-ai/dsh')?.version,
    lock.dsh.version, 'official package version must match the selected registry version')
  const packedFamilies = { dsh: members.dsh.length, vendor: members.vendor.length,
    landlock: existsSync(path.join(root, 'native/landlock-run/packages/entry/package.json')) ? 1 : 0 }
  return { sourceCommit: actualCommit, packageManager: manifest.packageManager, packedFamilies, members }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [root, filename] = process.argv.slice(2)
  const lock = JSON.parse(await readFile(filename, 'utf8'))
  const plan = await resolvePackedMembers(path.resolve(root), lock)
  Object.assign(lock.dsh, { packageManager: plan.packageManager, packedFamilies: plan.packedFamilies })
  await writeFile(filename, JSON.stringify(lock, null, 2) + '\n')
  await writeFile(path.join(path.dirname(filename), 'members.json'), JSON.stringify(plan, null, 2) + '\n')
  console.log(JSON.stringify({ sourceCommit: plan.sourceCommit, packedFamilies: plan.packedFamilies }))
}
