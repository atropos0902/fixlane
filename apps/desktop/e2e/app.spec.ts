import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Desk, steps } from './desk.ts'

let d: Desk
test.afterEach(() => d.close())

const inColumn = (name: string, title: string) =>
  d.page.getByRole('region', { name, exact: true }).getByText(title)

test('a ticket from the board to a merge, with the keyboard alone', async () => {
  d = await Desk.open(['ledger-2', 'ledger-3', 'beacon-2', 'harbor-1', 'harbor-9', 'parcel-3', 'mosaic-1'])
  const { page } = d
  const key = page.keyboard
  await expect(inColumn('Open', 'exportPath() leaves its folder')).toBeVisible()

  // To the ticket, however many stops away it is.
  for (
    let i = 0;
    i < 12 && !(await page.evaluate(() => document.activeElement?.classList.contains('card')));
    i++
  )
    await key.press('Tab')
  const on = (): Promise<string | undefined> =>
    page.evaluate(() => (document.activeElement as HTMLElement).dataset.id)
  for (let i = 0; i < 9 && (await on()) !== 'ledger-2'; i++) await key.press('ArrowDown')
  expect(await on()).toBe('ledger-2')
  await key.press('s')
  await expect(inColumn('In review', 'exportPath() leaves its folder')).toBeVisible({ timeout: 60_000 })

  await page.locator('[data-id="harbor-9"]').focus()
  await key.press('s')
  await expect(inColumn('Stopped', 'verify() does not look at exp')).toBeVisible({ timeout: 30_000 })
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'board.png') })
  await page.locator('[data-id="ledger-2"]').focus()
  await key.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Changes' })).toContainText('outside the export folder')
  const proof = page.getByRole('row', { name: /not a sibling either/ })
  await expect(proof).toContainText('fail')
  await expect(proof).toContainText('pass')
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'review.png') })

  d.host.settle('acme/ledger', 1, 'merged')
  await expect(page.getByRole('status')).toHaveText('Done')
  await key.press('Escape')
  await expect(inColumn('Done', 'exportPath() leaves its folder')).toBeVisible()
})

test('taking over: the agent freezes, a shell opens in its container, and handing back goes on', async () => {
  d = await Desk.open(['ledger-2'])
  const { page } = d
  await d.replay('ledger-2', [
    { run: 'for i in $(seq 60); do echo $i > count; sleep 0.1; done' },
    { run: 'rm count from-sam' },
    ...steps('ledger-2'),
  ])
  await page.locator('[data-id="ledger-2"]').click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: 'Take over' }).click()
  await expect(page.getByRole('status')).toHaveText('Paused, somebody is in its shell')
  await expect(page.locator('.term')).toContainText('/work$')
  await page.keyboard.type('whoami; pwd; echo hello > from-sam\n')
  const work = async (): Promise<string> => {
    const id = (await d.daemon.state()).tickets[0]!.local!.id
    return join(d.daemon.dir, 'work', `${id}-1`)
  }
  const file = async (f: string): Promise<string> => {
    try {
      return readFileSync(join(await work(), f), 'utf8')
    } catch {
      return ''
    }
  }
  await expect.poll(() => file('from-sam'), { timeout: 15_000 }).toBe('hello\n')
  const at = await file('count')
  await page.waitForTimeout(1200)
  expect(await file('count')).toBe(at)
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'takeover.png') })
  await page.keyboard.press('F6')
  await expect(page.getByRole('button', { name: /Hand back/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status')).toHaveText('Waiting for a reviewer', { timeout: 60_000 })
})

test('closing the window leaves the session alone', async () => {
  d = await Desk.open(['beacon-2'])
  await d.replay('beacon-2', [{ sleep: 3000 }, ...steps('beacon-2')])
  await d.page.locator('[data-id="beacon-2"]').focus()
  await d.page.keyboard.press('s')
  await expect(inColumn('Working', 'redact() misses headers in capitals')).toBeVisible()
  await d.app.close()
  await expect
    .poll(async () => (await d.daemon.state()).tickets[0]!.state, { timeout: 60_000 })
    .toBe('in_review')
  await d.launch()
  await expect(inColumn('In review', 'redact() misses headers in capitals')).toBeVisible()
})

test('a daemon that dies is noticed, and so is its return', async () => {
  d = await Desk.open(['beacon-2'])
  await d.daemon.kill()
  await expect(d.page.getByText('daemon stopped')).toBeVisible()
  await d.daemon.start()
  await expect(d.page.getByText('daemon stopped')).toBeHidden()
})

test('tickets, repositories and what the daemon refuses', async () => {
  d = await Desk.open(['beacon-2'])
  const { page } = d
  await expect(inColumn('Open', 'redact() misses headers in capitals')).toBeVisible()
  await page.keyboard.press('n')
  await page.getByLabel('Id', { exact: true }).fill('key-7')
  await page.getByLabel('Kind').selectOption('secret')
  await page.getByLabel('Title').fill('Key in ship.js')
  await page.getByLabel(/The key/).fill('a-very-secret-key')
  await page.getByRole('button', { name: 'File it' }).click()
  await expect(inColumn('Open', 'Key in ship.js')).toBeVisible()
  const filed = (await d.daemon.state()).tickets.find((t) => t.ticket.id === 'key-7')!
  expect(filed.ticket.key?.length).toBe(17)
  expect(JSON.stringify(filed)).not.toContain('a-very-secret-key')

  await page.keyboard.press('n')
  await page.getByLabel('Id', { exact: true }).fill('key-7')
  await page.getByLabel('Title').fill('Again')
  await page.getByRole('button', { name: 'File it' }).click()
  await expect(page.getByRole('alert')).toContainText('ticket key-7 exists')

  await page.keyboard.press('r')
  await page.getByLabel('Mode of beacon').selectOption('branch')
  await expect.poll(async () => (await d.daemon.state()).repos[0]!.mode).toBe('branch')
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard' })).toBeVisible()
})

test('the page has no way out but its bridge', async () => {
  d = await Desk.open(['beacon-2'])
  const { page } = d
  await expect(page.locator('.card').first()).toBeVisible()
  const seen = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>
    let reached = 'no'
    await fetch('http://127.0.0.1:1/').catch(() => {})
    await fetch('https://example.com/').then(
      () => {
        reached = 'yes'
      },
      () => {},
    )
    return {
      node: typeof w.require + typeof w.process + typeof w.Buffer,
      bridge: Object.keys(window.fixlane).sort(),
      reached,
      opened: window.open('https://example.com') === null,
    }
  })
  expect(seen.node).toBe('undefinedundefinedundefined')
  expect(seen.reached).toBe('no')
  expect(seen.opened).toBe(true)
  expect(seen.bridge).toEqual([
    'cancel',
    'comment',
    'file',
    'onPush',
    'openPull',
    'session',
    'setMode',
    'start',
    'state',
    'takeOver',
  ])
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y']) {
    expect(
      await page.evaluate(
        (u) =>
          window.fixlane.openPull(u).then(
            () => 'opened',
            () => 'refused',
          ),
        url,
      ),
    ).toBe('refused')
  }
  const evil = await page.evaluate(() =>
    window.fixlane.cancel('../../v1/state').then(
      () => 'asked',
      () => 'refused',
    ),
  )
  expect(evil).toBe('refused')
})
