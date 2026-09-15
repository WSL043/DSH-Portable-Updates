import test from 'node:test'
import assert from 'node:assert/strict'
import { adaptRuntimeVerifier } from '../scripts/adapt-runtime-verifier.mjs'

const source = `import {
  hasConversationPermissionLocalization,
  hasPermissionSettingsLocalization,
} from './patch-permission-localization.mjs'
assert.ok(hasConversationPermissionLocalization(readFileSync(conversationClientPath, 'utf8')))
`

test('published verifier uses both surfaces and requires an unchanged localized result', () => {
  const updated = adaptRuntimeVerifier(source)
  assert.ok(updated.includes("patchConversationPermissions(readFileSync(conversationClientPath, 'utf8'), readFileSync(permissionSettingsClientPath, 'utf8')) === readFileSync(conversationClientPath, 'utf8')"))
  assert.equal(adaptRuntimeVerifier(updated), updated)
  assert.ok(updated.includes('hasPermissionSettingsLocalization,'))
})

test('unexpected or duplicate verifier seams fail instead of weakening qualification', () => {
  assert.throws(() => adaptRuntimeVerifier(source.replace('conversationClientPath', 'otherPath')), /Unrecognized/)
  assert.throws(() => adaptRuntimeVerifier(source + source), /Unrecognized/)
})
