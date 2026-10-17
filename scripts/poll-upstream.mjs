#!/usr/bin/env node
// Local fast trigger for "Sync verified DSH core". GitHub delays cron runs by hours, so this checks npm every few
// minutes and dispatches the workflow the moment a published version has no qualification record yet.
// Read-only toward npm; the only write is one workflow_dispatch of our own workflow. Never releases a shell.
import { execFileSync, execSync } from 'node:child_process'

const REPO = 'WSL043/DSH-Portable-Updates'
const run = (cmd, args) => (cmd === 'npm' ? execSync(['npm', ...args].join(' '), { encoding: 'utf8' }) : execFileSync(cmd, args, { encoding: 'utf8' }))

// The default plugins re-qualify themselves (and publish on success) in their own "DSH compatibility autopilot", but
// only every 6 hours. Once upstream has an official GitHub Release for the newest version and a plugin's
// compatibility.json does not list it yet, start that plugin's autopilot right away.
async function dispatchPluginAutopilots(version) {
  const upstream = await fetch(`https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/v${version}`)
  if (!upstream.ok) return
  for (const repo of ['WSL043/dsh-image-viewer', 'WSL043/dsh-chat-manager']) {
    const file = JSON.parse(run('gh', ['api', `repos/${repo}/contents/compatibility.json`, '-H', 'Accept: application/vnd.github.raw']))
    if (file.releaseTargets.includes(version)) continue
    const active = JSON.parse(run('gh', ['run', 'list', '-R', repo, '--workflow', 'upstream-compatibility.yml', '-L', '5', '--json', 'status']))
    if (active.some((r) => r.status !== 'completed')) continue
    run('gh', ['workflow', 'run', 'upstream-compatibility.yml', '-R', repo, '--ref', 'main'])
    console.log(`dispatched ${repo} compatibility autopilot for ${version}`)
  }
}

const times = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'time', '--json']))
const newest = Object.entries(times).filter(([v]) => v !== 'created' && v !== 'modified').sort((a, b) => a[1].localeCompare(b[1])).at(-1)?.[0]
if (!newest) throw new Error('npm returned no versions')

const stateUrl = `https://github.com/${REPO}/releases/download/update-channel-core/qualification-state.json`
const state = await (await fetch(stateUrl, { redirect: 'follow' })).json()
await dispatchPluginAutopilots(newest)
if (state.some((entry) => entry.version === newest)) {
  console.log(`up to date: ${newest} already has a qualification record`)
  process.exit(0)
}
const active = JSON.parse(run('gh', ['run', 'list', '-R', REPO, '--workflow', 'sync-core.yml', '-L', '10', '--json', 'status']))
if (active.some((r) => r.status === 'in_progress' || r.status === 'queued' || r.status === 'pending')) {
  console.log(`new upstream ${newest}, a sync run is already active`)
  process.exit(0)
}
run('gh', ['workflow', 'run', 'sync-core.yml', '-R', REPO, '--ref', 'main', '-f', 'remaining=2'])
console.log(`new upstream ${newest}: dispatched Sync verified DSH core`)
