import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function coreResult({ channel, version, heldVersion, source, selected, resolve, preflight, build, publish, tag, reason, prepareOnly = false, preview }) {
  const outcome = !prepareOnly && publish === 'success' ? 'Published / 已发布'
    : preflight === 'blocked' ? 'Qualification blocked / 验收受阻'
    : resolve !== 'success' ? 'Source discovery failed / 上游来源核验失败'
    : selected !== 'true' ? 'No eligible work / 无需重新验证的版本'
    : prepareOnly && preview === 'success' && build === 'success' && publish === 'skipped' ? 'Prepared / 已准备，未发布'
    : prepareOnly ? 'Preparation failed / 准备失败'
    : 'Not published / 尚未发布'
  return `## ${channel} core: ${outcome}\n\n`
    + `- Core: ${version || heldVersion || 'none selected'}\n- Portable source: ${source || 'unresolved'}\n`
    + `- Resolve: ${resolve}; preflight: ${preflight || 'not reached'}; platforms: ${build}; publish: ${publish}\n`
    + (preflight === 'blocked' && reason ? `- First blocking gate: ${String(reason).replace(/[\r\n\t]/g, ' ').slice(0, 400)}\n` : '')
    + (preflight === 'blocked' ? '- This hold does not establish that later qualification gates pass.\n' : '')
    + (!prepareOnly && publish === 'success' ? `- [Published channel](https://github.com/WSL043/DSH-Portable-Updates/releases/tag/${encodeURIComponent(tag)})\n` : '')
    + '\nHistorical backfill and the newest core are qualified separately. A failed historical version does not undo a published core.\n'
}

export function coreResultExitCode({ preflight, prepareOnly, selected, resolve, preview, build, publish }) {
  return preflight === 'blocked' || (prepareOnly && (selected !== 'true' || resolve !== 'success'
    || preflight !== 'success' || preview !== 'success' || build !== 'success' || publish !== 'skipped')) ? 1 : 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const e = process.env
  const summary = coreResult({channel:e.CHANNEL,version:e.VERSION,heldVersion:e.HELD_VERSION,source:e.SOURCE_SHA,selected:e.SELECTED,
    resolve:e.RESOLVE_RESULT,preflight:e.PREFLIGHT_RESULT,build:e.BUILD_RESULT,publish:e.PUBLISH_RESULT,tag:e.CORE_TAG,
    reason:e.HOLD_REASON,prepareOnly:e.PREPARE_ONLY === 'true',preview:e.PREVIEW_RESULT})
  process.exitCode = coreResultExitCode({ preflight: e.PREFLIGHT_RESULT, prepareOnly: e.PREPARE_ONLY === 'true',
    selected: e.SELECTED, resolve: e.RESOLVE_RESULT, preview: e.PREVIEW_RESULT, build: e.BUILD_RESULT, publish: e.PUBLISH_RESULT })
  if (e.GITHUB_STEP_SUMMARY) await appendFile(e.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
}
