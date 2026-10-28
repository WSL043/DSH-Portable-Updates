import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidSemVer } from './build-core-index.mjs'

const PIPELINE_REPOSITORY = 'WSL043/DSH-Portable-Updates'
const SHA = /^[a-f0-9]{40}$/

function documentationPath(value) {
  return typeof value === 'string' && (['README.md', 'ARCHITECTURE.md'].includes(value)
    || /^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/.test(value))
}

// This proof must come from the fixed GitHub compare endpoint, never a workflow input.
export function assertDocumentationOnlyPipeline(comparison, preparedSha, pipelineSha) {
  assert.match(preparedSha, SHA)
  assert.match(pipelineSha, SHA)
  assert.notEqual(preparedSha, pipelineSha)
  assert.equal(comparison?.url, 'https://api.github.com/repos/' + PIPELINE_REPOSITORY + '/compare/' + preparedSha + '...' + pipelineSha, 'Unexpected pipeline comparison identity')
  assert.equal(comparison.status, 'ahead', 'Prepared pipeline must be an ancestor of current main')
  assert.equal(comparison.behind_by, 0)
  assert.equal(comparison.base_commit?.sha, preparedSha)
  assert.equal(comparison.merge_base_commit?.sha, preparedSha)
  assert.ok(Number.isSafeInteger(comparison.total_commits) && comparison.total_commits >= 1
    && comparison.total_commits <= 100, 'Pipeline comparison commit limit exceeded')
  assert.equal(comparison.ahead_by, comparison.total_commits)
  assert.ok(Array.isArray(comparison.commits))
  assert.equal(comparison.commits.length, comparison.total_commits, 'Truncated pipeline commit comparison')
  const commits = comparison.commits.map(commit => commit.sha)
  for (const sha of commits) assert.match(sha, SHA)
  assert.equal(new Set(commits).size, commits.length, 'Duplicate pipeline comparison commits')
  assert.equal(commits.at(-1), pipelineSha, 'Pipeline comparison does not reach current main')
  assert.notEqual(comparison.truncated, true, 'Truncated pipeline comparison')
  // GitHub caps the file list at 300; reject that boundary even if it happened to be complete.
  assert.ok(Array.isArray(comparison.files) && comparison.files.length >= 1 && comparison.files.length < 300,
    'Missing or potentially truncated pipeline file comparison')
  const paths = new Set()
  for (const file of comparison.files) {
    assert.ok(documentationPath(file.filename), 'Execution or unknown pipeline file changed; requalify before promotion')
    assert.ok(!paths.has(file.filename), 'Duplicate pipeline comparison file')
    paths.add(file.filename)
    assert.ok(['added', 'modified', 'removed', 'renamed'].includes(file.status), 'Unknown pipeline file status')
    assert.ok(typeof file.patch === 'string' && file.patch.length > 0 && file.truncated !== true,
      'Missing or truncated Markdown diff')
    if (file.status === 'renamed') {
      assert.ok(documentationPath(file.previous_filename), 'A renamed execution or unknown file requires requalification')
    } else {
      assert.equal(file.previous_filename, undefined, 'Unexpected pipeline rename metadata')
    }
  }
}

export function preparedCoreBaseSha(run, selection, { sourceSha, pipelineSha, runId }) {
  assert.match(String(runId), /^[1-9][0-9]*$/, 'Invalid prepared run ID')
  assert.ok(Number.isSafeInteger(Number(runId)) && run.id === Number(runId), 'Prepared run identity changed')
  for (const sha of [sourceSha, pipelineSha, run.head_sha]) assert.match(sha, SHA, 'Exact source identities required')
  assert.equal(run.repository?.full_name, PIPELINE_REPOSITORY, 'Unexpected prepared repository')
  assert.equal(run.head_repository?.full_name, PIPELINE_REPOSITORY, 'Forked preparation is not trusted')
  assert.equal(run.path, '.github/workflows/prepare-core.yml', 'Unexpected preparation workflow')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.head_branch, 'main', 'Preparation must use reviewed main workflow code')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success', 'Preparation did not pass all required jobs')
  assert.equal(selection.schemaVersion, 1)
  assert.equal(selection.sourceSha, sourceSha, 'Prepared Portable source differs from the published Native baseline')
  assert.equal(selection.pipelineSha, run.head_sha, 'Selection must name the actual prepared pipeline')
  assert.equal(selection.reason, 'prepare-only')
  assert.equal(selection.status, 'selected')
  assert.equal(selection.publish, true)
  assert.ok(isValidSemVer(selection.version), 'Invalid prepared core version')
  return run.head_sha
}

export function preparedCoreVersion(run, selection, identity, comparison) {
  const preparedSha = preparedCoreBaseSha(run, selection, identity)
  if (preparedSha !== identity.pipelineSha) {
    assert.ok(comparison, 'Preparation pipeline changed; requalify before promotion')
    assertDocumentationOnlyPipeline(comparison, preparedSha, identity.pipelineSha)
  }
  return selection.version
}

export function assertPreparedLock(prepared, selected) {
  assert.deepEqual(prepared, selected, 'Prepared source/dependency lock differs from fresh official selection')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2)
  const json = async file => JSON.parse(await readFile(file, 'utf8'))
  if (mode === 'run' || mode === 'base') {
    const [run, selection, sourceSha, pipelineSha, runId, comparison] = args
    const identity = { sourceSha, pipelineSha, runId }
    const preparedRun = await json(run), preparedSelection = await json(selection)
    if (mode === 'base') console.log(preparedCoreBaseSha(preparedRun, preparedSelection, identity))
    else console.log('version=' + preparedCoreVersion(preparedRun, preparedSelection, identity, comparison ? await json(comparison) : undefined))
  } else if (mode === 'lock') {
    assertPreparedLock(await json(args[0]), await json(args[1]))
  } else throw new Error('Expected base, run or lock verification')
}
