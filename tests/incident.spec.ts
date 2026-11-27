import { expect, test, type Page } from '@playwright/test'

/**
 * End-to-end checks for the evidence workflow. These cover the promises the
 * tool makes to an operator, not just that the page renders:
 *
 *  - raw timestamps survive calibration (the log is the record)
 *  - insufficient evidence yields an interval, never an invented order
 *  - adding batches/calibrations moves verdicts and the review says what moved
 *  - the causal chain is shown when it is what decided the order
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByTestId('timeline')).toBeVisible()
})

async function loadAll(page: Page) {
  await page.getByRole('tab', { name: '数据' }).click()
  await page.getByRole('button', { name: '全部加载' }).click()
  await page.getByRole('tab', { name: '时间线' }).click()
  await expect(page.locator('.timeline-scroll svg')).toBeVisible()
}

function eventGlyph(page: Page, id: string) {
  return page.locator(`.timeline-scroll [data-event="${id}"]`)
}

async function glyphTitle(page: Page, id: string): Promise<string> {
  return (await eventGlyph(page, id).locator('title').textContent()) ?? ''
}

/** "14:03:04.492" out of an aria-label / text block that contains it once. */
function clockOf(text: string, prefix = '原始 '): string {
  const m = text.match(new RegExp(`${prefix}(\\d{2}:\\d{2}:\\d{2}\\.\\d{3})`))
  if (!m) throw new Error(`no clock in: ${text}`)
  return m[1]
}

test('starts on one batch and shows the raw log as shipped', async ({ page }) => {
  await expect(page.getByText('已加载 1 / 3 批')).toBeVisible()

  // The ledger is not loaded yet: only gateway and order-service lanes exist.
  await expect(page.locator('.lane-label')).toHaveCount(2)
  await expect(page.getByText('账本数据库').first()).toBeVisible()

  // Every glyph carries its original stamp in its accessible label.
  const label = (await eventGlyph(page, 'gw:5').getAttribute('aria-label')) ?? ''
  expect(label).toContain('原始时钟 14:03:07.652')
})

test('a wide, jump-suspect interval is displayed as an interval and has no point estimate', async ({ page }) => {
  await loadAll(page)

  const title = await glyphTitle(page, 'gw:4')
  // 1.14s wide: the two bracketing readings disagree beyond the drift bound.
  expect(title).toContain('宽 1.140s')

  await eventGlyph(page, 'gw:4').click()
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByText('不给点估计')).toBeVisible()
  await expect(inspector.getByText('含未标注跳变')).toBeVisible()
  await expect(inspector.getByText('区间宽度')).toBeVisible()
  await expect(inspector.locator('.clock-row', { hasText: '区间宽度' })).toContainText('1.140s')
})

test('adding a calibration narrows the estimate and never touches the raw clock', async ({ page }) => {
  await loadAll(page)

  const before = await glyphTitle(page, 'gw:4')
  const rawBefore = clockOf(before)

  await page.getByRole('tab', { name: '数据' }).click()
  const anchorSelect = page.locator('.panel', { hasText: '补充校准点' }).locator('select').nth(1)
  await anchorSelect.selectOption('gw:4')
  const preview = page.locator('.anchor-preview')
  await expect(preview).toContainText(`原始时钟 ${rawBefore}`)

  await page.getByPlaceholder('14:03:04.050 或 4.050').first().fill('14:03:03.990')
  await page.getByRole('button', { name: '加入校准点' }).click()
  await expect(page.getByText('校准点已加入')).toBeVisible()

  // The manual calibration is listed, so it can be withdrawn later.
  const manual = page.locator('.manual-evidence')
  await expect(manual).toContainText('gw:4')
  await expect(manual).toContainText('撤回')

  await page.getByRole('tab', { name: '时间线' }).click()
  const after = await glyphTitle(page, 'gw:4')
  expect(clockOf(after)).toBe(rawBefore)
  const width = Number(/(?:宽|（宽) ?([\d.]+)(ms|s)/.exec(after)?.[1] ?? NaN)
  expect(width).toBeLessThan(1140)

  // It is now anchored by a reading: a point estimate exists and the
  // jump-suspect warning is gone.
  await eventGlyph(page, 'gw:4').click()
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByText('不给点估计')).toHaveCount(0)
  await expect(inspector.getByText('含未标注跳变')).toHaveCount(0)
  await expect(inspector.getByText('锚定')).toBeVisible()
})

test('loading more batches rewrites verdicts and the review lists what changed', async ({ page }) => {
  const status = page.locator('.topbar-status')
  const before = await status.innerText()

  await loadAll(page)
  const after = await status.innerText()
  expect(after).not.toBe(before)

  await page.getByRole('tab', { name: '复盘' }).click()
  const review = page.getByTestId('review-view')
  await expect(review).toContainText('快照 v1 → v2')
  await expect(review.locator('.delta-item.changed').first()).toContainText('改写')
  // The retry question flips to a hold once the downstream batch arrives.
  await expect(review.locator('.delta-item', { hasText: '网关重试发送' })).toContainText('成立')
})

test('insufficient evidence reports an overlap instead of an order', async ({ page }) => {
  await loadAll(page)

  await eventGlyph(page, 'cache:3').click()
  await eventGlyph(page, 'ord:8').click({ modifiers: ['Shift'] })

  const pair = page.getByTestId('pair-relation')
  await expect(pair).toContainText('同一时间（不可定序）')
  await expect(pair).toContainText('重叠')
  await expect(pair).toContainText('证据不足以定序')
})

test('a causal chain decides the order when clocks are weaker', async ({ page }) => {
  await loadAll(page)

  await eventGlyph(page, 'gw:5').click()
  await eventGlyph(page, 'db:9').click({ modifiers: ['Shift'] })

  const pair = page.getByTestId('pair-relation')
  await expect(pair).toContainText('A 早于 B')
  await expect(pair).toContainText('跨进程因果链')
  // The full path is still available as text, collapsed to process hops.
  const chain = pair.locator('.chain')
  await expect(chain).toHaveAttribute('title', /gw:5 → ord:9/)
  await expect(chain).toContainText('gw')
  await expect(chain).toContainText('ord')
  await expect(chain).toContainText('db')
})

test('the raw-clock mode redraws with each machine’s own stamps', async ({ page }) => {
  await loadAll(page)
  const calibratedTicks = await page.locator('.tick-label').allTextContents()

  await page.getByRole('button', { name: '原始时钟', exact: true }).click()
  await expect(page.getByText('按各机器自己的时钟绘制，不做任何改写')).toBeVisible()
  const rawTicks = await page.locator('.tick-label').allTextContents()
  expect(rawTicks.length).toBeGreaterThan(1)
  expect(rawTicks).not.toEqual(calibratedTicks)

  // db's clock is ~12s ahead; raw mode must actually show that.
  const label = (await eventGlyph(page, 'db:0').getAttribute('aria-label')) ?? ''
  expect(label).toContain('14:03:12.540')

  await page.getByRole('button', { name: '校准后', exact: true }).click()
  await expect(page.locator('.tick-label').first()).toHaveText(calibratedTicks[0])
})

test('the rail shows the latest snapshot and its rewrites', async ({ page }) => {
  await loadAll(page)
  const rail = page.locator('.rail-latest')
  await expect(rail).toContainText('快照 v2')
  await expect(rail).toContainText('改写')
  await expect(rail).toContainText('查看哪些结论需要修订')
})

test('a narrow viewport stacks the panels without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 })
  await page.reload()
  await expect(page.getByTestId('timeline')).toBeVisible()

  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  expect(overflow.doc).toBeLessThanOrEqual(0)

  // The timeline itself scrolls horizontally inside its own card.
  const scroller = await page
    .locator('.timeline-scroll')
    .evaluate((n) => ({ client: (n as HTMLElement).clientWidth, scroll: (n as HTMLElement).scrollWidth }))
  expect(scroller.scroll).toBeGreaterThan(scroller.client)
})

test('no page errors across all four views', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  for (const tab of ['时钟', '复盘', '数据', '时间线']) {
    await page.getByRole('tab', { name: tab }).click()
    await page.waitForTimeout(150)
  }
  expect(errors).toEqual([])
})
