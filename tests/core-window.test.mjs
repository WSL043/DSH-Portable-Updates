import assert from 'node:assert/strict'
import test from 'node:test'

import { selectCoreWindow } from '../scripts/core-window.mjs'

test('the newest five versions, as long as two of them are not alphas', () => {
  assert.deepEqual(selectCoreWindow(['0.2.1-rc.2', '0.2.1-rc.1', '0.2.1-alpha.5', '0.2.1-alpha.4', '0.2.1-alpha.3', '0.2.1-alpha.2']),
    ['0.2.1-rc.2', '0.2.1-rc.1', '0.2.1-alpha.5', '0.2.1-alpha.4', '0.2.1-alpha.3'])
})

test('alphas give way to the newest release candidates and finals', () => {
  const sorted = ['0.3.0-alpha.5', '0.3.0-alpha.4', '0.3.0-alpha.3', '0.3.0-alpha.2', '0.3.0-alpha.1', '0.2.1', '0.2.1-rc.2', '0.2.1-rc.1']
  assert.deepEqual(selectCoreWindow(sorted), ['0.3.0-alpha.5', '0.3.0-alpha.4', '0.3.0-alpha.3', '0.2.1', '0.2.1-rc.2'])
  assert.deepEqual(selectCoreWindow(['0.3.0-alpha.2', '0.3.0-alpha.1', '0.2.1-rc.2']), ['0.3.0-alpha.2', '0.3.0-alpha.1', '0.2.1-rc.2'])
})
