import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function coreResult({ channel, version, source, selected, resolve, preflight, build, publish, tag, reason }) {
  const outcome = publish === 'success' ? 'Published / 已发布'
    : preflight === 'blocked' ? 'Needs a compatible baseline / 等待适配'
    : resolve !== 'success' ? 'Source discovery failed / 上游来源核验失败'
    : selected !== 'true' ? 'No eligible work / 无需重新验证的版本'
    : 'Not published / 尚未发布'
  return `## ${channel} core: ${outcome}\n\n`
    + `- Core: ${version || 'none selected'}\n- Portable source: ${source || 'unresolved'}\n`
    + `- Resolve: ${resolve}; preflight: ${preflight || 'not reached'}; platforms: ${build}; publish: ${publish}\n`
    + (preflight === 'blocked' && reason ? `- First blocking gate: ${String(reason).replace(/[\r\n\t]/g, ' ').slice(0, 400)}\n` : '')
    + (preflight === 'blocked' ? '- This hold does not establish that later compatibility and historical-session migration gates pass.\n' : '')
    + (publish === 'success' ? `- [Published channel](https://github.com/WSL043/DSH-Portable-Updates/releases/tag/${encodeURIComponent(tag)})\n` : '')
    + '\nHistorical backfill and the newest core are qualified separately. A failed historical version does not undo a published core.\n'
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const e = process.env
  const summary = coreResult({channel:e.CHANNEL,version:e.VERSION,source:e.SOURCE_SHA,selected:e.SELECTED,
    resolve:e.RESOLVE_RESULT,preflight:e.PREFLIGHT_RESULT,build:e.BUILD_RESULT,publish:e.PUBLISH_RESULT,tag:e.CORE_TAG,
    reason:e.HOLD_REASON})
  if (e.GITHUB_STEP_SUMMARY) await appendFile(e.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
}
