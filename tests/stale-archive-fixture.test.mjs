import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { seedStaleArchive } from '../scripts/verify-default-plugin-ui.mjs'

test('stale archive fixture requires a host-created workspace and preserves its data', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-archive-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'data/dsh-home/storages/workspace.json')
  await assert.rejects(seedStaleArchive(root, 'synthetic-absent'), { code: 'ENOENT' })
  const registry = { global: { archivedSessionIds: ['synthetic-absent'], keep: 'preserved' }, workspaces: { example: { label: 'preserve' } } }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(registry))
  await seedStaleArchive(root, 'synthetic-absent')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), registry)
  await writeFile(file, '{invalid')
  await assert.rejects(seedStaleArchive(root, 'another'), SyntaxError)
  assert.equal(await readFile(file, 'utf8'), '{invalid')
})
