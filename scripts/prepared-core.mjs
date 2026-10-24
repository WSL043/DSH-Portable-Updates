import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidSemVer } from './build-core-index.mjs'

export function preparedCoreVersion(run, selection, { sourceSha, pipelineSha, runId }) {
  assert.match(String(runId), /^[1-9][0-9]*$/, 'Invalid prepared run ID')
  assert.ok(Number.isSafeInteger(Number(runId)) && run.id === Number(runId), 'Prepared run identity changed')
  for (const sha of [sourceSha, pipelineSha]) assert.match(sha, /^[a-f0-9]{40}$/, 'Exact source identities required')
  assert.equal(run.repository?.full_name, 'WSL043/DSH-Portable-Updates', 'Unexpected prepared repository')
  assert.equal(run.head_repository?.full_name, 'WSL043/DSH-Portable-Updates', 'Forked preparation is not trusted')
  assert.equal(run.path, '.github/workflows/prepare-core.yml', 'Unexpected preparation workflow')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.head_branch, 'main', 'Preparation must use reviewed main workflow code')
  assert.equal(run.head_sha, pipelineSha, 'Preparation pipeline changed; requalify before promotion')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success', 'Preparation did not pass all required jobs')
  assert.equal(selection.schemaVersion, 1)
  assert.equal(selection.sourceSha, sourceSha, 'Prepared Portable source differs from the published Native baseline')
  assert.equal(selection.pipelineSha, pipelineSha)
  assert.equal(selection.reason, 'prepare-only')
  assert.equal(selection.status, 'selected')
  assert.equal(selection.publish, true)
  assert.ok(isValidSemVer(selection.version), 'Invalid prepared core version')
  return selection.version
}

export function assertPreparedLock(prepared, selected) {
  assert.deepEqual(prepared, selected, 'Prepared source/dependency lock differs from fresh official selection')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2)
  const json = async file => JSON.parse(await readFile(file, 'utf8'))
  if (mode === 'run') {
    const [run, selection, sourceSha, pipelineSha, runId] = args
    console.log('version=' + preparedCoreVersion(await json(run), await json(selection), { sourceSha, pipelineSha, runId }))
  } else if (mode === 'lock') {
    assertPreparedLock(await json(args[0]), await json(args[1]))
  } else throw new Error('Expected run or lock verification')
}
