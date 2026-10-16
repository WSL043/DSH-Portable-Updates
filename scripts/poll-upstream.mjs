#!/usr/bin/env node
// Local fast trigger for "Sync verified DSH core". GitHub delays cron runs by hours, so this checks npm every few
// minutes and dispatches the workflow the moment a published version has no qualification record yet.
// Read-only toward npm; the only write is one workflow_dispatch of our own workflow. Never releases a shell.
import { execFileSync, execSync } from 'node:child_process'

const REPO = 'WSL043/DSH-Portable-Updates'
const run = (cmd, args) => (cmd === 'npm' ? execSync(['npm', ...args].join(' '), { encoding: 'utf8' }) : execFileSync(cmd, args, { encoding: 'utf8' }))

const times = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'time', '--json']))
const newest = Object.entries(times).filter(([v]) => v !== 'created' && v !== 'modified').sort((a, b) => a[1].localeCompare(b[1])).at(-1)?.[0]
if (!newest) throw new Error('npm returned no versions')

const stateUrl = `https://github.com/${REPO}/releases/download/update-channel-core/qualification-state.json`
const state = await (await fetch(stateUrl, { redirect: 'follow' })).json()
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
