import test from 'node:test'
import assert from 'node:assert/strict'
import { coreResult } from '../scripts/report-core-result.mjs'

const base = {channel:'candidate',version:'0.1.7-alpha.2',source:'source',selected:'true',resolve:'success',preflight:'success',build:'success',publish:'success',tag:'update-channel-core-candidate'}
test('only completed publication claims delivery and links its channel', () => {
  assert.match(coreResult(base), /已发布/)
  assert.match(coreResult(base), /\[Published channel\]/)
  const failed=coreResult({...base,publish:'failure'})
  assert.match(failed,/尚未发布/)
  assert.doesNotMatch(failed,/\[Published channel\]/)
})
test('summaries distinguish blocked, absent work and discovery failure', () => {
  assert.match(coreResult({...base,publish:'skipped',preflight:'blocked'}),/等待适配/)
  assert.match(coreResult({...base,publish:'skipped',selected:'false'}),/无需重新验证/)
  assert.match(coreResult({...base,publish:'skipped',selected:'false',resolve:'failure'}),/来源核验失败/)
})
