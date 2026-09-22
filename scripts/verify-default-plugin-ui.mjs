import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Operate real official controls; never remove onboarding DOM or patch the host. */
export async function verifyDefaultPluginUi(page, evidence) {
  const errors = []
  const onError = error => errors.push(error.message)
  const onConsole = message => {
    // React error boundaries report to console without emitting pageerror.
    if (message.type() === 'error' && /React error|slot entry crashed|TypeError|ReferenceError/.test(message.text())) errors.push(message.text())
  }
  page.on('pageerror', onError)
  page.on('console', onConsole)
  try {
    for (const name of [/^(继续|Continue)$/, /^(稍后配置|Configure later)$/]) {
      const button = page.getByRole('button', { name })
      if (await button.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false)) await button.click()
    }
    const selected = page.getByRole('treeitem').filter({ hasText: 'Portable default plugin qualification' }).last()
    if (!await selected.isVisible()) {
      const ungrouped = page.getByText(/^(未分组|Ungrouped)$/, { exact: true })
      if (await ungrouped.isVisible()) await ungrouped.click()
    }
    await selected.click()
    const later = page.getByRole('button', { name: /^(稍后配置|Configure later)$/ })
    if (await later.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) await later.click()
    const input = page.locator('[contenteditable="true"][role="textbox"]').first()
    await input.fill('Disposable core qualification draft')
    const clipboard = await page.evaluateHandle(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 640; canvas.height = 480
      const context = canvas.getContext('2d')
      context.fillStyle = '#888'; context.fillRect(0, 0, 640, 480)
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'synthetic-core-qualification.png', { type: 'image/png' }))
      return data
    })
    try {
      await input.evaluate((element, clipboardData) => element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })), clipboard)
    } finally { await clipboard.dispose() }
    const thumbnails = page.locator('[role="group"] button[title]').filter({ has: page.locator(':scope > img') })
    await thumbnails.first().click()
    const viewer = page.locator('.niv-root')
    await viewer.waitFor()
    await viewer.getByRole('button', { name: /^(Mark region|标记区域)$/ }).click()
    await viewer.locator('.niv-image').click()
    await viewer.locator('textarea').fill('Qualification annotation')
    await page.screenshot({ path: path.join(evidence, 'image-annotation.png') })
    await viewer.locator('.niv-close-floating').click()
    await viewer.waitFor({ state: 'hidden' })
    await thumbnails.nth(1).waitFor()
    const text = await input.innerText()
    assert.ok(text.includes('Disposable core qualification draft'))
    assert.ok(text.includes('Qualification annotation'), 'annotation returns through the real attachment/draft API')
    const row = selected
    await row.hover()
    await row.getByRole('button', { name: /Session actions|会话.*操作/ }).click()
    await page.getByRole('menuitem', { name: /^(永久删除|删除会话|Delete session|Delete permanently)$/ }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: /永久删除|permanently|Permanently/ }).last()
    await dialog.waitFor()
    await page.screenshot({ path: path.join(evidence, 'session-delete-confirmation.png') })
    await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).last().click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await input.isEditable(), true, 'cancelled deletion leaves composer editable')
    assert.ok((await input.innerText()).includes('Qualification annotation'), 'cancel preserves the draft')
    await page.screenshot({ path: path.join(evidence, 'composer-after-plugin-actions.png') })
    assert.deepEqual(errors, [], 'no swallowed overlay or React errors')
    return { ok: true, imageAnnotation: true, draftPreserved: true, sessionDeleteCancel: true, errors }
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
    await writeFile(path.join(evidence, 'errors.json'), JSON.stringify({ error: String(error), errors }, null, 2))
    throw error
  } finally {
    page.off('pageerror', onError)
    page.off('console', onConsole)
  }
}

export async function verifyNativeDefaultPlugins(root, playwrightManifest) {
  assert.equal(process.platform, 'win32', 'native WebView2 qualification requires Windows')
  root = path.resolve(root)
  const { chromium } = createRequire(path.resolve(playwrightManifest))('playwright')
  const components = JSON.parse(await readFile(path.join(root, 'licenses/COMPONENTS.json'), 'utf8'))
  const fixtureEnv = { ...process.env, DSH_PORTABLE_STATE_ROOT: root, DSH_PORTABLE_ENVIRONMENT: 'default',
    DSH_HOME: path.join(root, 'data/dsh-home'), DSH_TELEMETRY_MODE: 'DISABLED' }
  const seedEnv = { ...fixtureEnv }
  for (const key of Object.keys(seedEnv)) if (/API_KEY|TOKEN|SECRET/i.test(key)) delete seedEnv[key]
  let seed
  try {
    seed = await exec(path.join(root, 'runtime/node/node.exe'), [path.join(root, 'launcher/runtime-entry.mjs'),
      'dsh-cli.mjs', '--profile', 'headless', 'Portable default plugin qualification session'],
    { cwd: root, windowsHide: true, timeout: 90000, env: seedEnv })
  } catch (error) { seed = error }
  // A clean, keyless disposable product persists the synthetic prompt, but must
  // not call a real model. Other failures are not successful fixture creation.
  assert.match(`${seed.stdout ?? ''}\n${seed.stderr ?? ''}`, /MISSING_CREDENTIAL/, 'keyless synthetic session was created')
  const results = []
  for (const theme of ['dark', 'light']) {
    const evidence = path.join(root, 'acceptance/default-plugin-ui', theme)
    await mkdir(evidence, { recursive: true })
    await mkdir(path.join(root, 'data/dsh-home'), { recursive: true })
    await writeFile(path.join(root, 'data/dsh-home/settings.yaml'), `ui-theme:\n  preference: ${theme}\n`)
    const reserve = createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    const port = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
    const child = spawn(path.join(root, 'DeepSeek-Herness.exe'), [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
      ...fixtureEnv, DSH_PORTABLE_SKIP_UPDATE_CHECK: '1', DSH_PORTABLE_TEST_HIDDEN: '1', DSH_PORTABLE_TEST_AUTOMATION: '1',
      DSH_PORTABLE_TEST_WEBVIEW2_ARGUMENTS: `--remote-debugging-port=${port}`,
    } })
    let browser
    try {
      const deadline = Date.now() + 120000
      while (Date.now() < deadline && !browser) {
        try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }) } catch { await delay(250) }
      }
      assert.ok(browser, 'native WebView2 remote debugging is available')
      const page = browser.contexts()[0].pages()[0]
      page.setDefaultTimeout(20000)
      await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 90000 })
      assert.equal(await page.evaluate(() => Boolean(window.chrome?.webview)), true, 'this is the native WebView, not a substitute browser')
      await page.waitForFunction(() => document.querySelector('[data-dsh-boot]') === null)
      results.push({ theme, ...(await verifyDefaultPluginUi(page, evidence)) })
    } finally {
      await browser?.close().catch(() => {})
      try {
        await exec(path.join(root, 'runtime/node/node.exe'), [path.join(root, 'launcher/runtime-entry.mjs'), 'portable-cli.mjs', 'stop', '--json'], { cwd: root, env: fixtureEnv, windowsHide: true, timeout: 120000 })
      } finally { if (child.exitCode === null) child.kill() }
    }
  }
  const report = { ok: true, portableVersion: components.portableVersion, dshVersion: components.dshVersion, defaultPlugins: components.defaultPlugins, results }
  await writeFile(path.join(root, 'acceptance/default-plugin-ui/result.json'), JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [root, playwrightManifest, disposable] = process.argv.slice(2)
  assert.ok(root && playwrightManifest && disposable === '--disposable', 'usage: verify-default-plugin-ui.mjs <disposable-product> <playwright-package-anchor> --disposable')
  console.log(JSON.stringify(await verifyNativeDefaultPlugins(root, playwrightManifest)))
}
