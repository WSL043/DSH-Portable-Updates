import { spawnSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const ADAPTERS = ['session-export-ui', 'permission-localization', 'theme-bootstrap',
  'native-boot-handoff', 'native-settings-command', 'loopback-connection',
  'portable-hero-context', 'client-module-startup', 'windows-subprocess-hide']

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
  const result = preflightAdapters(...process.argv.slice(2))
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `\nAdapter preflight: **${result.status}**${result.adapter ? ` (${result.adapter}) — ${result.reason}` : ''}\n`)
  console.log(JSON.stringify(result))
  if (result.status !== 'success') process.exitCode = 1
}
