/**
 * Visual verification driver. Not part of the app; run against `vite preview`.
 *
 * Every load starts from clean storage, so each capture is reproducible.
 */
import { chromium } from 'playwright'

const base = 'http://127.0.0.1:4173/'
const out = '/tmp/shots'
const VIEW = { timeline: '时间线', clock: '时钟', review: '复盘', data: '数据' }

async function open(browser, theme, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.evaluate((t) => {
    localStorage.clear()
    document.documentElement.dataset.theme = t
  }, theme)
  await page.reload({ waitUntil: 'networkidle' })
  await page.evaluate((t) => {
    localStorage.setItem(
      'chronoscope-v1',
      JSON.stringify({
        state: {
          theme: t,
          leftOpen: true,
          inspectorOpen: true,
          loadedBatchIds: [],
          manualEvents: [],
          manualEdges: [],
          manualCalibrations: [],
          manualQuestions: [],
          hiddenEdgeIds: [],
          snapshots: [],
          reviewedAt: {},
        },
        version: 0,
      }),
    )
  }, theme)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  return page
}

async function loadAll(page) {
  await page.getByRole('tab', { name: VIEW.data }).click()
  const btn = page.getByRole('button', { name: '全部加载' })
  if (await btn.count()) await btn.click()
  await page.waitForTimeout(600)
  await page.getByRole('tab', { name: VIEW.timeline }).click()
  await page.waitForTimeout(400)
}

const browser = await chromium.launch()
const errors = []
const watch = (p) => p.on('pageerror', (e) => errors.push(e.message))

// ---- dark, 1440, all evidence
const p1 = await open(browser, 'dark', 1440, 900)
watch(p1)
await loadAll(p1)
await p1.screenshot({ path: `${out}/d-timeline-all.png` })

await p1.getByRole('tab', { name: VIEW.review }).click()
await p1.waitForTimeout(400)
await p1.screenshot({ path: `${out}/d-review-all.png` })
await p1.screenshot({ path: `${out}/d-review-all-full.png`, fullPage: true })

await p1.getByRole('tab', { name: VIEW.clock }).click()
await p1.waitForTimeout(300)
await p1.getByRole('button', { name: /账本数据库/ }).first().click()
await p1.waitForTimeout(400)
await p1.screenshot({ path: `${out}/d-clock-db.png` })

await p1.getByRole('tab', { name: VIEW.data }).click()
await p1.waitForTimeout(300)
await p1.screenshot({ path: `${out}/d-data-all.png` })

// raw clock, 1x
await p1.getByRole('tab', { name: VIEW.timeline }).click()
await p1.getByRole('button', { name: '原始时钟', exact: true }).click()
await p1.waitForTimeout(300)
await p1.screenshot({ path: `${out}/d-timeline-raw.png` })
await p1.getByRole('button', { name: '校准后', exact: true }).click()
await p1.waitForTimeout(300)

// a real cross-process pair: gw:5 (retry) vs db:9 (commit 2)
const gw5 = p1.locator('[data-event="gw:5"]')
const db9 = p1.locator('[data-event="db:9"]')
await gw5.scrollIntoViewIfNeeded()
await gw5.click({ force: true })
await db9.scrollIntoViewIfNeeded()
await db9.click({ force: true, modifiers: ['Shift'] })
await p1.waitForTimeout(400)
await p1.screenshot({ path: `${out}/d-pair-gw5-db9.png` })
const pairText = await p1.getByTestId('pair-relation').innerText()

// zoom, on the calibrated axis
await p1.getByRole('button', { name: '4×', exact: true }).click()
await p1.waitForTimeout(300)
await p1.screenshot({ path: `${out}/d-timeline-zoom.png` })
await p1.getByRole('button', { name: '1×', exact: true }).click()

// rail delta text after three batches
const railText = await p1.locator('.rail-latest').innerText()
const headerText = await p1.locator('.topbar-status').innerText()

await p1.close()

// ---- light, 1440
const p2 = await open(browser, 'light', 1440, 900)
watch(p2)
await loadAll(p2)
await p2.screenshot({ path: `${out}/l-timeline.png` })
await p2.getByRole('tab', { name: VIEW.clock }).click()
await p2.waitForTimeout(400)
await p2.screenshot({ path: `${out}/l-clock.png` })
await p2.getByRole('tab', { name: VIEW.review }).click()
await p2.waitForTimeout(400)
await p2.screenshot({ path: `${out}/l-review.png` })
await p2.getByRole('tab', { name: VIEW.data }).click()
await p2.waitForTimeout(300)
await p2.screenshot({ path: `${out}/l-data.png` })
await p2.close()

// ---- narrow
const p3 = await open(browser, 'dark', 900, 1000)
watch(p3)
await loadAll(p3)
await p3.screenshot({ path: `${out}/n-900.png` })
await p3.close()

const p4 = await open(browser, 'dark', 620, 900)
watch(p4)
await p4.screenshot({ path: `${out}/n-620.png`, fullPage: true })
await p4.close()

console.log(
  JSON.stringify(
    {
      rail: railText,
      header: headerText,
      pair: pairText,
      errors,
    },
    null,
    2,
  ),
)
await browser.close()
