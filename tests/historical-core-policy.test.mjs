import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptHistoricalVerifier, isKnownDescriptorV2Failure, isKnownHistoricalWriterFailure } from '../scripts/historical-core-policy.mjs'

test('only the recognized descriptor-v2 fold assertion is advisory', () => {
  let known
  try { assert.ok(undefined, 'current subagent runtime must recognize the restored descriptor') } catch (error) { known = error }
  assert.equal(isKnownDescriptorV2Failure(known), true)
  assert.equal(isKnownDescriptorV2Failure(new Error(known.message)), false)
  assert.equal(isKnownDescriptorV2Failure({ ...known, message: 'other assertion' }), false)
  assert.equal(isKnownDescriptorV2Failure({ ...known, actual: false }), false)
})

test('packaged historical probes allow only that precise writer assertion', () => {
  const known = { status: 1, stderr: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\r\n+ undefined\r\n at C:\\runner\\experiments\\descriptor-v2\\writer-probe.mjs:68:8' }
  assert.equal(isKnownHistoricalWriterFailure(known), true)
  assert.equal(isKnownHistoricalWriterFailure({ ...known, status: 2 }), false)
  assert.equal(isKnownHistoricalWriterFailure({ ...known, stderr: known.stderr.replace('68:8', '70:8') }), false)
  assert.equal(isKnownHistoricalWriterFailure({ ...known, stderr: known.stderr.replace('+ undefined', '+ broken') }), false)
})

test('an unknown published test runner fails for review', () => {
  assert.throws(() => adaptHistoricalVerifier('unexpected source', 'file:///helper.mjs'), /Unrecognized published historical verifier/)
})
