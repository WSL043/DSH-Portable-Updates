import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const ADAPTERS = ['session-export-ui', 'permission-localization', 'theme-bootstrap',
  'native-boot-handoff', 'native-settings-command', 'loopback-connection',
  'portable-hero-context', 'client-module-startup', 'windows-subprocess-hide']

export function checkDefaultPluginCapabilities(lock, workspaceClient) {
  // This exact shipped client uses the official session-menu extension, not a
  // copied workspace. Do not qualify an older host by merely skipping its UI test.
  if (lock.defaultPlugins?.chatManager?.version === '1.5.0'
    && !workspaceClient.includes('"sidebar.workspaces.session.menu.item"')) {
    return { status: 'blocked', adapter: 'default-plugin-host-capability',
      reason: 'Bundled Session Manager 1.5.0 requires the official session-menu slot missing from this core.' }
  }
  return { status: 'success' }
}

export function checkDefaultPluginPeers(lock, manifests, dshVersion, satisfies) {
  for (const pin of Object.values(lock.defaultPlugins ?? {})) {
    const manifest = manifests[pin.package]
    if (manifest?.name !== pin.package || manifest.version !== pin.version) {
      return { status: 'failed', adapter: 'default-plugin-peers',
        reason: `Pinned plugin metadata could not be verified: ${pin.package}@${pin.version}.` }
    }
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@deepseek-ai/dsh-') || manifest.peerDependenciesMeta?.[peer]?.optional === true) continue
      if (typeof range !== 'string' || !satisfies(dshVersion, range, { includePrerelease: true })) {
        return { status: 'blocked', adapter: 'default-plugin-peers',
          reason: `${pin.package}@${pin.version} requires ${peer} ${range}; candidate core is ${dshVersion}. Publish and qualify a compatible default plugin before delivering this core.` }
      }
    }
  }
  return { status: 'success' }
}

export async function fetchPinnedDefaultPluginManifests(lock, request = fetch) {
  const manifests = {}
  for (const pin of Object.values(lock.defaultPlugins ?? {})) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pin.package)}/${encodeURIComponent(pin.version)}`
    const response = await request(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DSH-Portable-core-preflight' } })
    if (!response.ok) throw new Error(`Pinned plugin metadata request failed: ${pin.package}@${pin.version} (${response.status})`)
    manifests[pin.package] = await response.json()
  }
  return manifests
}

export function preflightAdapters(root, app, run = spawnSync) {
  for (const adapter of ADAPTERS) {
    const result = run(process.execPath, [path.resolve(root, 'scripts', `patch-${adapter}.mjs`), path.resolve(app)],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (result.status === 0 && !result.error) continue
    // Only explicit structural incompatibility is permanent for this baseline.
    // Missing files, process errors and other failures retain ordinary retry rules.
    const structural = !result.error && result.status !== 0
      && /seam changed upstream|expected 1 match, found \d+/.test(result.stderr ?? '')
    return { status: structural ? 'blocked' : 'failed', adapter,
      detail: String(result.error?.message || result.stderr || '').slice(-4000),
      reason: structural ? 'Published Portable adapter needs a new compatible baseline.' : 'Adapter preflight failed; inspect retained job logs.' }
  }
  return { status: 'success' }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [root, app, lockFile] = process.argv.slice(2)
  let result = { status: 'success' }
  if (lockFile) {
    const lock = JSON.parse(await readFile(lockFile, 'utf8'))
    const version = lock.dsh?.version
    const product = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const productLock = JSON.parse(await readFile(path.join(root, product.version.includes('-') ? 'upstream.preview.lock.json' : 'upstream.lock.json'), 'utf8'))
    const semver = createRequire(path.join(root, 'app/package.json'))('semver')
    result = checkDefaultPluginPeers(productLock, await fetchPinnedDefaultPluginManifests(productLock), version, semver.satisfies)
    if (result.status === 'success') {
      const client = await readFile(path.join(app, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'), 'utf8')
      result = checkDefaultPluginCapabilities(productLock, client)
    }
  }
  if (result.status === 'success') result = preflightAdapters(root, app)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `\nAdapter preflight: **${result.status}**${result.adapter ? ` (${result.adapter}) — ${result.reason}` : ''}\n`)
  console.log(JSON.stringify(result))
  if (result.status !== 'success') process.exitCode = 1
}
