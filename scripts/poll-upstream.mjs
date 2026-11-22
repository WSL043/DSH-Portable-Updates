#!/usr/bin/env node
// Scheduled fallback for GitHub's delayed cron. Only dispatches the existing qualification workflows.
import { execFileSync, execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { selectNativeRelease } from './select-native-release.mjs'
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

export function retryUnassignedCoreRunner(record, invoke = run) {
  if (record?.status !== 'failed') return null
  const api = route => JSON.parse(invoke('gh', ['api', 'repos/' + CORE_REPO + '/' + route]))
  const { workflow_runs: [latest] } = api('actions/workflows/sync-core.yml/runs?branch=main&per_page=1')
  const attempted = Date.parse(record.attemptedAt)
  if (latest?.conclusion !== 'failure' || latest.run_attempt !== 1 || latest.head_sha !== record.pipelineSha
      || !(attempted >= Date.parse(latest.created_at) && attempted <= Date.parse(latest.updated_at))) return null

  const { jobs } = api('actions/runs/' + latest.id + '/jobs?per_page=100')
  const builds = jobs.filter(job => job.name.startsWith('core / build ('))
  const cancelled = builds.find(job => job.conclusion === 'cancelled' && !job.runner_name && job.steps.length === 0)
  if (builds.length !== 5 || builds.filter(job => job.conclusion === 'success').length !== 4
      || !cancelled || !jobs.some(job => job.name === 'core / publish' && job.conclusion === 'skipped')) return null
  const annotations = api('check-runs/' + cancelled.id + '/annotations')
  if (!annotations.some(entry => entry.annotation_level === 'failure'
      && entry.message.startsWith('The job was not acquired by Runner of type hosted'))) return null

  const baseline = JSON.parse(invoke('gh', ['api', 'repos/' + DESKTOP_REPO + '/releases/latest']))
  if (baseline.target_commitish !== record.sourceSha) return null
  const { assets } = JSON.parse(invoke('gh', ['release', 'view', 'update-channel-core-stable', '-R', CORE_REPO, '--json', 'assets']))
  if (!assets.length || assets.some(asset => !(Date.parse(asset.updatedAt) <= Date.parse(latest.created_at)))) return null

  invoke('gh', ['run', 'rerun', '-R', CORE_REPO, '--job', String(cancelled.id)])
  return 'Core ' + record.version + ': scheduled poll retried unassigned runner ' + cancelled.html_url
}

async function pollCore() {
  const times = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'time', '--json']))
  const newest = Object.entries(times).filter(([v]) => v !== 'created' && v !== 'modified').sort((a, b) => a[1].localeCompare(b[1])).at(-1)?.[0]
  if (!newest) throw new Error('npm returned no versions')

  const stateUrl = 'https://github.com/' + CORE_REPO + '/releases/download/update-channel-core/qualification-state.json'
  const state = await (await get(stateUrl, fetch)).json()
  const baseline = selectNativeRelease(JSON.parse(run('gh', ['api', 'repos/' + DESKTOP_REPO + '/releases?per_page=100'])))
  const pipeline = JSON.parse(run('gh', ['api', 'repos/' + CORE_REPO + '/commits/main'])).sha
  const newestRecords = state.filter(entry => entry.version === newest && entry.sourceSha === baseline.target_commitish)
  if (newestRecords.some(entry => entry.status === 'success')) return 'Core ' + newest + ' already has a successful qualification'
  const record = newestRecords.filter(entry => entry.pipelineSha === pipeline)
    .sort((a, b) => String(b.attemptedAt).localeCompare(String(a.attemptedAt)))[0]
  if (record && (record.status === 'blocked' || Date.parse(record.retryAfter) > Date.now())) {
    return retryUnassignedCoreRunner(record) ?? ('Core ' + newest + ': last qualification is ' + record.status)
  }

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
