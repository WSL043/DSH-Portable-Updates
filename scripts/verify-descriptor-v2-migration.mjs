import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageNames = [
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-format-v0-to-v1',
]

async function loadPackage(appRoot, name) {
  const root = path.join(appRoot, 'node_modules', ...name.split('/'))
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const entry = path.resolve(root, manifest.main)
  const relative = path.relative(root, entry)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Package entry escapes ${name}`)
  return import(pathToFileURL(entry).href)
}

export async function verifyDescriptorV2Migration(appRoot) {
  const [format, legacy] = await Promise.all(packageNames.map(name => loadPackage(appRoot, name)))
  const catalog = format.createSessionFormatCatalog({
    currentVersion: 1,
    codecs: [legacy.releasedV0SessionFormatCodec, legacy.releasedV1SessionFormatCodec],
    currentEncoder: { encodeHeader: value => value, encodeEvent: value => value },
    migrations: [legacy.sessionFormatV0ToV1],
    restoreCurrent: value => value,
    restoreTransformedCurrent: value => value,
    restoreCurrentHeader: value => value,
  })
  const restore = version => {
    const current = catalog.createRestore({
      type: 'session', version: 0, id: `portable-historical-descriptor-v${version}`,
      createdAt: 1, delegationDepth: 0,
    }, { recovery: 'strict', validation: 'transformed' })
    current.decodeRow({ type: 'subagent/descriptor', seq: 0, time: 2,
      data: { mode: 'one-shot', version, provider: 'fixture-provider' } })
    return current.finish()
  }

  const v3 = restore(3)
  assert.equal(v3.events[0].data.version, 3)
  assert.throws(() => restore(4))
  const v2 = restore(2)
  assert.equal(v2.header.version, 1)
  assert.equal(v2.events.length, 1)
  assert.equal(v2.events[0].data.version, 2)
  return { status: 'passed', packages: packageNames.map(name => name), fixture: 'released-v0-descriptor-v2' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = process.argv[2]
  if (!appRoot) throw new Error('usage: node verify-descriptor-v2-migration.mjs <staged-app-root>')
  try {
    console.log(JSON.stringify(await verifyDescriptorV2Migration(path.resolve(appRoot))))
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'status=success\n')
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      '\nReleased descriptor-v2 migration fixture: **passed**.\n')
  } catch (error) {
    const blocked = error?.name === 'SessionFormatUnsupportedMigrationError'
      && /subagent\/descriptor.*version 2/.test(error.message)
    const status = blocked ? 'blocked' : 'failed'
    const reason = blocked
      ? 'The packaged core cannot restore released descriptor-v2 sessions; upstream migration support is required.'
      : 'Descriptor-v2 migration verification failed; inspect the preview-runtime job log.'
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${status}\nreason=${reason}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `\nReleased descriptor-v2 migration: **${status}** — ${reason}\n`)
    console.error(`Released descriptor-v2 session migration is not qualified: ${error?.stack || error}`)
    process.exitCode = 1
  }
}
