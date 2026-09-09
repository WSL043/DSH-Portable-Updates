import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolvePackedMembers } from '../scripts/resolve-packed-members.mjs'

test('source metadata follows the pinned official membership, not matching directory counts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-official-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'scripts/release'), { recursive: true })
  await mkdir(path.join(root, 'apps/private-tool'), { recursive: true })
  await writeFile(path.join(root, 'apps/private-tool/package.json'), '{"private":true}')
  await writeFile(path.join(root, 'package.json'), '{"packageManager":"pnpm@11.7.0"}')
  await writeFile(path.join(root, 'scripts/release/families.ts'), `
export function releaseFamily(id: string) {
  return { members() { return id === 'dsh'
    ? [{ name: '@deepseek-ai/dsh', version: '0.1.5-alpha.1', directory: 'apps/dsh' }]
    : [{ name: '@deepseek-ai/vendor', version: '1.0.0', directory: 'vendor/library' }] } }
}`)
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  const lock = { dsh: { reviewedCommit: git('rev-parse', 'HEAD'), version: '0.1.5-alpha.1' } }
  const plan = await resolvePackedMembers(root, lock)
  assert.deepEqual(plan.packedFamilies, { dsh: 1, vendor: 1, landlock: 0 })
  assert.equal(plan.members.dsh[0].name, '@deepseek-ai/dsh')
  await assert.rejects(resolvePackedMembers(root, { dsh: { ...lock.dsh, version: '0.1.3-alpha.2' } }), /registry version/)
  await assert.rejects(resolvePackedMembers(root, { dsh: { ...lock.dsh, reviewedCommit: '0'.repeat(40) } }), /immutable source lock/)
})
