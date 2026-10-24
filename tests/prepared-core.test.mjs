import test from 'node:test'
import assert from 'node:assert/strict'
import { preparedCoreVersion, assertPreparedLock } from '../scripts/prepared-core.mjs'
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
