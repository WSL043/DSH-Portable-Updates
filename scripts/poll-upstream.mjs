#!/usr/bin/env node
// Scheduled fallback for GitHub's delayed cron. Only dispatches the existing qualification workflows.
import { execFileSync, execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { compareVersions, isValidSemVer } from './build-core-index.mjs'

const CORE_REPO = 'WSL043/DSH-Portable-Updates'
const DESKTOP_REPO = 'WSL043/DSH-Portable'
const DESKTOP_WORKFLOW = 'official-desktop-channel.yml'
const DESKTOP_CRON_GRACE_MS = 90 * 60 * 1000

const run = (cmd, args) => (cmd === 'npm' ? execSync(['npm', ...args].join(' '), { encoding: 'utf8', windowsHide: true }) : execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }))

async function get(url, request) {
  const response = await request(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url)
  return response
}

async function pollCore() {
  const times = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'time', '--json']))
  const newest = Object.entries(times).filter(([v]) => v !== 'created' && v !== 'modified').sort((a, b) => a[1].localeCompare(b[1])).at(-1)?.[0]
  if (!newest) throw new Error('npm returned no versions')

  const stateUrl = 'https://github.com/' + CORE_REPO + '/releases/download/update-channel-core/qualification-state.json'
  const state = await (await get(stateUrl, fetch)).json()
  if (state.some(entry => entry.version === newest)) return 'Core ' + newest + ' already has a qualification record'

  const active = JSON.parse(run('gh', ['run', 'list', '-R', CORE_REPO, '--workflow', 'sync-core.yml', '-L', '10', '--json', 'status']))
  if (active.some(r => r.status !== 'completed')) return 'Core ' + newest + ': a sync run is already active'
  const link = run('gh', ['workflow', 'run', 'sync-core.yml', '-R', CORE_REPO, '--ref', 'main', '-f', 'remaining=2']).trim()
  return 'Core ' + newest + ': scheduled poll dispatched Sync verified DSH core ' + link
}

async function readDesktopVersion(url, request, optional = false) {
  const response = await request(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
  if (response.status === 404 && optional) return null
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url)
  const content = await response.text()
  const versions = [...content.matchAll(/^version:[ \t]*(\S+)[ \t]*\r?$/gm)]
  if (content.length > 32768 || versions.length !== 1 || !isValidSemVer(versions[0][1])) {
    throw new Error('Invalid Desktop feed version at ' + url)
  }
  return versions[0][1]
}

export async function pollOfficialDesktop({ request = fetch, invoke = run, now = Date.now() } = {}) {
  const official = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/'
  const published = 'https://github.com/' + DESKTOP_REPO + '/releases/download/update-channel-desktop/'
  let candidate
  for (const channel of ['nightly', 'stable']) {
    const upstream = await readDesktopVersion(official + channel + '.yml', request, channel === 'stable')
    if (!upstream || (channel === 'stable' && !/^\d+\.\d+\.\d+$/.test(upstream))) continue
    const current = await readDesktopVersion(published + channel + '.yml', request, true)
    if (current && compareVersions(upstream, current) <= 0) continue
    candidate = { channel, version: upstream }
    break
  }
  if (!candidate) return 'Desktop: published channels are up to date'

  const runs = JSON.parse(invoke('gh', ['run', 'list', '-R', DESKTOP_REPO, '--workflow', DESKTOP_WORKFLOW, '-L', '10', '--json', 'status,createdAt,event']))
  const label = 'Desktop ' + candidate.channel + ' ' + candidate.version
  if (runs.some(run => run.status !== 'completed')) return label + ': a qualification run is already active'
  // Prefer the hosted cron when it is running. Also bound retries after any dispatch.
  if (runs.some(run => (run.event === 'schedule' || run.event === 'workflow_dispatch')
      && now - Date.parse(run.createdAt) < DESKTOP_CRON_GRACE_MS)) {
    return label + ': waiting for the hosted schedule or recent qualification'
  }

  const link = invoke('gh', ['workflow', 'run', DESKTOP_WORKFLOW, '-R', DESKTOP_REPO, '--ref', 'main', '-f', 'publish_channel=true']).trim()
  return label + ': scheduled poll dispatched qualification ' + link
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const result of await Promise.allSettled([pollCore(), pollOfficialDesktop()])) {
    if (result.status === 'fulfilled') console.log(result.value)
    else {
      console.error(result.reason.message)
      process.exitCode = 1
    }
  }
}
