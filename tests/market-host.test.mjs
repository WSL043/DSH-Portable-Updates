import assert from 'node:assert/strict'
import test from 'node:test'
import { bindMarketHost } from '../scripts/bind-market-host.mjs'

test('qualification binds only our market settings peer to the exact official host', () => {
  const original = { name: '@wsl043/dsh-portable-plugin-market',
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-settings': '^0.1.3-alpha.2' },
    peerDependenciesMeta: { '@deepseek-ai/dsh-settings': { optional: true } } }
  const plan = { members: { dsh: [{ name: '@deepseek-ai/dsh-settings', version: '0.1.5-alpha.1' }] } }
  const bound = bindMarketHost(original, plan)
  assert.equal(bound.peerDependencies['@deepseek-ai/dsh-settings'], '0.1.5-alpha.1')
  assert.equal(bound.peerDependencies['@deepseek-ai/cordis'], '^4.0.1')
  assert.deepEqual(bound.peerDependenciesMeta, original.peerDependenciesMeta)
  assert.equal(original.peerDependencies['@deepseek-ai/dsh-settings'], '^0.1.3-alpha.2')
  assert.throws(() => bindMarketHost({ ...original, name: 'third-party-plugin' }, plan))
  assert.throws(() => bindMarketHost(original, { members: { dsh: [] } }))
})

test('a prerelease official cordis is bound exactly; a stable one keeps the shipped range', () => {
  const original = { name: '@wsl043/dsh-portable-plugin-market',
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-settings': '^0.2.0-rc.2' } }
  const settings = [{ name: '@deepseek-ai/dsh-settings', version: '0.2.1-alpha.1' }]
  const alpha = bindMarketHost(original, { members: { dsh: settings, vendor: [{ name: '@deepseek-ai/cordis', version: '4.0.5-alpha.1' }] } })
  assert.equal(alpha.peerDependencies['@deepseek-ai/cordis'], '4.0.5-alpha.1')
  assert.equal(alpha.peerDependencies['@deepseek-ai/dsh-settings'], '0.2.1-alpha.1')
  const stable = bindMarketHost(original, { members: { dsh: settings, vendor: [{ name: '@deepseek-ai/cordis', version: '4.0.4' }] } })
  assert.equal(stable.peerDependencies['@deepseek-ai/cordis'], '^4.0.1')
  assert.equal(original.peerDependencies['@deepseek-ai/cordis'], '^4.0.1')
})
