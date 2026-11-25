import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Contacts, the project's small CRM: added by hand on the Contacts tab and by the
 * agent through its contacts_* tools (called over HTTP the way Claude Code calls
 * them), a status change written into the history, follow-ups that are due
 * called out on the tab and on Today.
 */
let mcpUrl = ''
let wsId = ''
let chatId = ''

async function tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(wsId)}&chat=${encodeURIComponent(chatId)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    }
  )
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6)
  const msg = JSON.parse(json) as {
    result?: { content: { text?: string }[] }
    error?: { message: string }
  }
  if (msg.error) throw new Error(msg.error.message)
  return msg.result!.content.map((c) => c.text ?? '').join('\n')
}

test('contacts: by hand and by the agent, status history, follow-ups due, Today', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-contacts-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-contacts-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const urlFile = join(data, 'mcp-url.txt')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_MCP_URL_FILE: urlFile,
      NODE_ENV: 'production'
    }
  })
  try {
    const page: Page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect.poll(() => existsSync(urlFile)).toBe(true)
    mcpUrl = readFileSync(urlFile, 'utf8')
    const made = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      return { wsId: ws.id, chatId: await window.cove.chatCreate(ws.id) }
    })
    wsId = made.wsId
    chatId = made.chatId
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')

    // The Todo panel's second tab.
    await page.locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible').first().click()
    await page.getByTestId('tab-contacts').click()
    const panel = page.getByTestId('contacts-panel')
    await expect(panel).toContainText('No contacts yet')

    // By hand.
    await panel.getByRole('button', { name: '+ Add' }).click()
    const form = page.getByTestId('contact-new')
    await form.getByPlaceholder('Name or organisation').fill('Studio café')
    await form.getByPlaceholder('Email (optional)').fill('info@studio.example')
    await form.getByPlaceholder('What you are asking for (optional)').fill('Crew food, January')
    await form.getByRole('button', { name: 'Add' }).click()
    const detail = page.getByTestId('contact-detail')
    await expect(detail).toContainText('Studio café')

    // By the agent: a list at once, a duplicate skipped.
    const added = await tool('contacts_add', {
      contacts: [
        {
          name: 'Max Wagner',
          org: 'Angel investor',
          ask: 'EP, €2,500',
          status: 'waiting',
          followUp: '2020-01-01'
        },
        { name: 'City cultural office', email: 'kultur@city.example', ask: 'Short film grant' },
        { name: 'Studio café' }
      ]
    })
    expect(added).toContain('Added 2: Max Wagner, City cultural office.')
    expect(added).toContain('Already there: Studio café.')
    await expect(page.getByTestId('contact-row')).toHaveCount(3)

    // Max's follow-up has come: called out, and first in the list.
    await expect(page.getByTestId('contacts-due')).toContainText('1 follow-up is due')
    await expect(page.getByTestId('contacts-due')).toContainText('Max Wagner')
    await expect(page.getByTestId('contact-row').first()).toContainText('Max Wagner')
    await expect(page.getByTestId('contact-row').first()).toContainText('Follow up')

    // The agent records a reply; it is in the contact's history.
    const upd = await tool('contacts_update', {
      contact: 'Max Wagner',
      status: 'replied',
      note: 'Wants a call next week'
    })
    expect(upd).toContain('"status":"replied"')
    await page.getByTestId('contact-row').filter({ hasText: 'Max Wagner' }).click()
    await expect(detail).toContainText('Wants a call next week')
    await expect(detail).toContainText('Status: replied')
    await expect(page.getByTestId('contacts-due')).toHaveCount(0)

    // A status picked by hand.
    await detail.getByRole('button', { name: 'Yes', exact: true }).click()
    await expect(detail).toContainText('Status: yes')
    const listed = await tool('contacts_list', { status: 'yes' })
    expect(listed).toContain('Max Wagner')
    expect(await tool('contacts_list', { status: 'due' })).toContain('No contacts')

    // Dynamic: the agent is asked to track something new, and the list adapts.
    expect(await tool('contacts_fields')).toContain('No fields beyond the built-in ones yet.')
    await tool('contacts_update', {
      contact: 'Studio café',
      fields: { Budget: '€2,000', Country: 'Germany' }
    })
    await tool('contacts_add', {
      contacts: [
        {
          name: 'Art foundation',
          ask: 'Six months',
          fields: { budget: '€18,000', Deadline: '2026-12-15' }
        }
      ]
    })
    // Same label, any case: one field. Three fields in all.
    const fields = await tool('contacts_fields')
    expect(fields).toContain('Budget (number)')
    expect(fields).toContain('Country (text)')
    expect(fields).toContain('Deadline (date)')
    expect(fields.match(/Budget/g)).toHaveLength(1)
    // The agent reads a contact's fields by their labels.
    expect(await tool('contacts_list')).toContain('"Budget": "€2,000"')
    // They show on the list, and are searchable.
    const studio = page.getByTestId('contact-row').filter({ hasText: 'Studio café' })
    // With a contact open the list stays narrow; closed, the tags are there.
    await page.getByTestId('contact-detail').getByTitle('Close').click()
    await expect(studio).toContainText('€2,000')
    await page.getByPlaceholder('Search').fill('germany')
    await expect(page.getByTestId('contact-row')).toHaveCount(1)
    await page.getByPlaceholder('Search').fill('')
    // And on the contact, to edit; the change reaches the agent.
    await studio.click()
    await expect(page.getByTestId('field-country').locator('input')).toHaveValue('Germany')
    await page.getByTestId('field-budget').locator('input').fill('€2,500')
    await page.getByTestId('field-budget').locator('input').blur()
    await expect.poll(() => tool('contacts_list')).toContain('"Budget": "€2,500"')
    // By hand: a field of your own, there for every contact.
    await page.getByTestId('add-field').click()
    await page.getByPlaceholder('Field name, e.g. Budget').fill('Priority')
    await page.getByPlaceholder('Field name, e.g. Budget').press('Enter')
    await expect(page.getByTestId('field-priority')).toBeVisible()
    await page.getByTestId('field-priority').locator('input').fill('High')
    await page.getByTestId('field-priority').locator('input').blur()
    await expect.poll(() => tool('contacts_fields')).toContain('Priority (text)')
    // The agent takes one away: gone from the contacts and from the panel.
    expect(await tool('contacts_fields', { remove: 'Country' })).toContain('Removed "Country"')
    await expect(page.getByTestId('field-country')).toHaveCount(0)
    expect(await tool('contacts_list')).not.toContain('Germany')

    if (process.env.SHOT) {
      await tool('contacts_add', {
        contacts: [
          {
            name: 'Bar Nord',
            org: 'Owner unclear, call first',
            channel: 'Phone',
            ask: 'Location 10–14 Jan',
            status: 'sent',
            followUp: '2099-01-10'
          },
          { name: 'Art foundation', email: 'info@foundation.example', ask: '€18,000, six months' },
          {
            name: 'Regional film fund',
            email: 'film@region.example',
            ask: '€500 micro-grant',
            status: 'no'
          },
          {
            name: 'Lena Fischer',
            org: 'Friend of the project',
            channel: 'WhatsApp',
            ask: 'Name + 2–3 intros',
            status: 'sent',
            followUp: '2020-02-01'
          }
        ]
      })
      await page.getByTestId('contact-row').filter({ hasText: 'Art foundation' }).click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(process.env.SHOT, 'contacts.png') })
    }

    // Today shows what is due, from any project.
    await tool('contacts_update', {
      contact: 'City cultural office',
      status: 'sent',
      followUp: '2020-01-02'
    })
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cove:open-today')))
    await expect(page.getByTestId('today-followups')).toContainText('City cultural office', {
      timeout: 10_000
    })
    if (process.env.SHOT)
      await page.screenshot({ path: join(process.env.SHOT, 'contacts-today.png') })
    // And clicking one goes to the project's Contacts tab.
    await page.getByTestId('today-followups').getByText('City cultural office').click()
    await expect(page.getByTestId('contacts-panel')).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
