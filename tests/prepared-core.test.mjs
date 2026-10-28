import test from 'node:test'
import assert from 'node:assert/strict'
import { preparedCoreVersion, preparedCoreBaseSha, assertPreparedLock } from '../scripts/prepared-core.mjs'
const sourceSha='a'.repeat(40), pipelineSha='b'.repeat(40)
const run={id:123,repository:{full_name:'WSL043/DSH-Portable-Updates'},head_repository:{full_name:'WSL043/DSH-Portable-Updates'},path:'.github/workflows/prepare-core.yml',event:'workflow_dispatch',head_branch:'main',head_sha:pipelineSha,status:'completed',conclusion:'success'}
const selection={schemaVersion:1,sourceSha,pipelineSha,reason:'prepare-only',status:'selected',publish:true,version:'0.2.1-rc.3'}
const identity={sourceSha,pipelineSha,runId:'123'}
test('promotion accepts only successful exact main preparation for the published source',()=>{
  assert.equal(preparedCoreVersion(run,selection,identity),'0.2.1-rc.3')
  for(const changed of [{id:124},{repository:{full_name:'other/repo'}},{head_repository:{full_name:'other/fork'}},{path:'.github/workflows/sync-core.yml'},{event:'pull_request'},{head_branch:'feature'},{head_sha:'c'.repeat(40)},{status:'in_progress'},{conclusion:'failure'}]) assert.throws(()=>preparedCoreVersion({...run,...changed},selection,identity))
  for(const changed of [{sourceSha:'c'.repeat(40)},{pipelineSha:'c'.repeat(40)},{reason:'published'},{status:'blocked'},{publish:false},{version:'not-a-version'}]) assert.throws(()=>preparedCoreVersion(run,{...selection,...changed},identity))
  assert.throws(()=>preparedCoreVersion(run,selection,{...identity,runId:'123; echo unsafe'}))
})
test('promotion rechecks the complete selected lock, including dependency repair policy',()=>{
  const lock={node:{version:'24.22.1'},dsh:{version:'0.2.1-rc.3',buildDependencies:{zod:{version:'4.6.7'}}},pnpm:{sourceBuild:{patchSha256:'a'.repeat(64)}}}
  assertPreparedLock(lock,structuredClone(lock))
  const changed=structuredClone(lock);changed.pnpm.sourceBuild.patchSha256='b'.repeat(64)
  assert.throws(()=>assertPreparedLock(lock,changed),/differs/)
})

test('promotion reads accepted artifacts directly but keeps identity and byte checks before signing', async () => {
  const { readFile } = await import('node:fs/promises')
  const workflow = (await readFile(new URL('../.github/workflows/sync-core-channel.yml', import.meta.url), 'utf8')).replaceAll('\r', '')
  const job = name => {
    const start = workflow.indexOf('\n  ' + name + ':\n')
    assert.ok(start >= 0, 'Missing ' + name + ' job')
    const tail = workflow.slice(start + 1)
    // Job bodies are indented by at least four spaces; only a two-space key ends one.
    const next = /\n  [a-z][a-z-]*:\n/.exec(tail)
    return next ? tail.slice(0, next.index) : tail
  }
  const resolve = job('resolve'), publish = job('publish')
  assert.match(resolve, /PIPELINE_SHA: \$\{\{ github\.sha \}\}/)
  assert.match(resolve, /PIPELINE_REF: \$\{\{ github\.ref \}\}/)
  assert.match(resolve, /test "\$PIPELINE_REF" = refs\/heads\/main/)
  assert.match(resolve, /PREPARED_PIPELINE_SHA="\$\(node update-channel\/scripts\/prepared-core\.mjs base/)
  assert.match(resolve, /gh api "repos\/WSL043\/DSH-Portable-Updates\/compare\/\$PREPARED_PIPELINE_SHA\.\.\.\$PIPELINE_SHA\?per_page=100&page=1" > prepared-pipeline-compare\.json/)
  assert.ok(resolve.indexOf('prepared-core.mjs base') < resolve.indexOf('/compare/'), 'The base run is authenticated before fetching its comparison')
  assert.match(resolve, /prepared-core\.mjs run prepared-run\.json prepared-selection\/selection\.json "\$SOURCE_SHA" "\$PIPELINE_SHA" "\$PREPARED_RUN_ID"/)
  assert.match(resolve, /prepared-core\.mjs lock prepared-core\/lock\.json resolved-core\/lock\.json/)
  assert.match(publish, /needs: \[resolve, build\]/)
  assert.match(publish, /!inputs\.prepare_only && needs\.resolve\.result == 'success'/)
  assert.match(publish, /needs\.build\.result == 'success' \|\| inputs\.prepared_run_id != ''/)
  assert.match(publish, /pattern: core-stable-\*\n\s+repository: WSL043\/DSH-Portable-Updates\n\s+run-id: \$\{\{ inputs\.prepared_run_id \|\| github\.run_id \}\}\n\s+github-token: \$\{\{ github\.token \}\}/)
  assert.doesNotMatch(workflow, /reuse-prepared:|name: core-stable-prepared/)
  assert.doesNotMatch(publish, /actions\/upload-artifact/)

  const verify = publish.indexOf('node scripts/verify-update-artifact.mjs "$MANIFEST" "$ZIP" engine')
  const sign = publish.indexOf('node update-channel/scripts/sign-update-metadata.mjs publish')
  const upload = publish.indexOf('gh release upload')
  assert.ok(verify >= 0 && sign > verify && upload > sign, 'Archive verification must precede signing and publication')
  assert.match(publish.slice(0, verify), /for platform in windows-x64 macos-arm64 macos-x64 linux-x64 linux-arm64; do/)
  const binding = publish.indexOf('--bind-core-envelope')
  assert.ok(binding >= 0 && binding < verify, 'The frozen baseline binding still applies before verification')

  // The same pinned workflow revision is already tested in resolve before any publication.
  assert.match(resolve, /node --test update-channel\/tests\/\*\.test\.mjs/)
  assert.doesNotMatch(publish, /node --test/)
  for (const name of ['channel-result', 'qualification-state']) {
    const report = job(name)
    assert.match(report, /BUILD_RESULT:.*inputs\.prepared_run_id != '' && needs\.publish\.result == 'success'/)
    assert.match(report, /PREVIEW_RESULT:.*inputs\.prepared_run_id != '' && needs\.publish\.result == 'success'/)
  }
})


function documentationComparison() {
  const currentSha = 'c'.repeat(40)
  return {
    url: 'https://api.github.com/repos/WSL043/DSH-Portable-Updates/compare/' + pipelineSha + '...' + currentSha,
    status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
    base_commit: { sha: pipelineSha }, merge_base_commit: { sha: pipelineSha },
    commits: [{ sha: currentSha }],
    files: [{ filename: 'README.md', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
  }
}

test('only a complete trusted main-ancestor Markdown comparison permits a different pipeline', () => {
  const current = { ...identity, pipelineSha: 'c'.repeat(40) }
  const comparison = documentationComparison()
  assert.equal(preparedCoreBaseSha(run, selection, current), pipelineSha)
  assert.equal(preparedCoreVersion(run, selection, current, comparison), selection.version)
  comparison.files.push({ filename: 'docs/maintenance/guide.md', previous_filename: 'ARCHITECTURE.md',
    status: 'renamed', patch: '@@ -1 +1 @@\n-old\n+new' })
  assert.equal(preparedCoreVersion(run, selection, current, comparison), selection.version)
  assert.throws(() => preparedCoreVersion(run, selection, current), /pipeline changed/)
  // A valid documentation proof does not authenticate a different run, source or selection.
  assert.throws(() => preparedCoreVersion({ ...run, head_branch: 'feature' }, selection, current, comparison))
  assert.throws(() => preparedCoreVersion({ ...run, conclusion: 'failure' }, selection, current, comparison))
  assert.throws(() => preparedCoreVersion(run, selection, { ...current, sourceSha: 'd'.repeat(40) }, comparison))
  assert.throws(() => preparedCoreVersion(run, { ...selection, pipelineSha: current.pipelineSha }, current, comparison))
})

test('code, unsafe renames, diverged or incomplete comparisons never reuse prepared cores', () => {
  const current = { ...identity, pipelineSha: 'c'.repeat(40) }
  const reject = mutate => {
    const comparison = documentationComparison()
    mutate(comparison)
    assert.throws(() => preparedCoreVersion(run, selection, current, comparison))
  }
  for (const filename of ['scripts/prepared-core.mjs', '.github/workflows/sync-core-channel.yml',
    'package-lock.json', 'unknown.md', 'docs/../README.md', 'docs/guide.md.mjs', 'docs/guide.MD']) {
    reject(proof => { proof.files[0].filename = filename })
  }
  reject(proof => { proof.files[0].status = 'renamed'; proof.files[0].previous_filename = 'scripts/retired.mjs' })
  reject(proof => { proof.files[0].status = 'renamed'; proof.files[0].previous_filename = 'docs/old.md'; proof.files[0].filename = 'scripts/new.mjs' })
  reject(proof => { proof.files[0].status = 'renamed' })
  reject(proof => { proof.files[0].status = 'copied' })
  reject(proof => { delete proof.files[0].patch })
  reject(proof => { proof.files[0].truncated = true })
  reject(proof => { proof.truncated = true })
  reject(proof => { proof.status = 'diverged' })
  reject(proof => { proof.status = 'behind' })
  reject(proof => { proof.behind_by = 1 })
  reject(proof => { proof.base_commit.sha = 'd'.repeat(40) })
  reject(proof => { proof.merge_base_commit.sha = 'd'.repeat(40) })
  reject(proof => { proof.url = proof.url.replace('WSL043/', 'other/') })
  reject(proof => { proof.url = proof.url.replace(current.pipelineSha, 'd'.repeat(40)) })
  reject(proof => { proof.commits[0].sha = 'd'.repeat(40) })
  reject(proof => { proof.commits = [] })
  reject(proof => { proof.commits.push({ sha: current.pipelineSha }); proof.total_commits = proof.ahead_by = 2 })
  reject(proof => { proof.total_commits = proof.ahead_by = 101 })
  reject(proof => { proof.total_commits = proof.ahead_by = 2 })
  reject(proof => { proof.ahead_by = 2 })
  reject(proof => { delete proof.files })
  reject(proof => { proof.files = [] })
  reject(proof => { proof.files.push({ ...proof.files[0] }) })
  reject(proof => { proof.files = Array.from({ length: 300 }, (_, index) => ({ ...proof.files[0], filename: 'docs/page' + index + '.md' })) })
})
