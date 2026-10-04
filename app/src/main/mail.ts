import { execFile } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { kvGet, kvSet } from './store'
import { COMPOSE_SCRIPT, MAIL_SCRIPT } from './mail-script'
import type { MailConnectionStatus } from '../shared/mail'

const KEY = 'connections.appleMail'
const locator = {
  accountId: z.string().min(1).max(1000),
  mailboxPath: z.array(z.string().min(1).max(1000)).min(1).max(20),
  messageId: z.number().int().nonnegative()
}
export const mailSchemas = {
  accounts: z.object({}),
  search: z.object({
    query: z.string().max(500).default(''),
    accountId: locator.accountId.optional(),
    mailboxPath: locator.mailboxPath.optional(),
    unreadOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(10000).default(0)
  }),
  read: z.object({ ...locator, maxChars: z.number().int().min(1).max(30000).default(12000) }),
  draft: z.object(compose()),
  send: z.object(compose())
}

/** A message to save or send: recipients, subject, body, and files to attach. */
function compose(): {
  to: z.ZodArray<z.ZodEmail>
  cc: z.ZodDefault<z.ZodArray<z.ZodEmail>>
  bcc: z.ZodDefault<z.ZodArray<z.ZodEmail>>
  subject: z.ZodString
  body: z.ZodString
  html: z.ZodDefault<z.ZodString>
  attachments: z.ZodDefault<z.ZodArray<z.ZodString>>
} {
  return {
    to: z.array(z.email().max(320)).min(1).max(50),
    cc: z.array(z.email().max(320)).max(50).default([]),
    bcc: z.array(z.email().max(320)).max(50).default([]),
    subject: z.string().max(1000),
    /** Plain text: the whole message, or the fallback beside the HTML. */
    body: z.string().max(50000),
    /** Formatted body (a designed signature, a newsletter). Images by https URL. */
    html: z.string().max(200000).default(''),
    /** Absolute paths of files on this Mac. */
    attachments: z.array(z.string().min(1).max(2000)).max(20).default([])
  }
}

/** Attachments must be real files, named by absolute path; ~ is the home folder. */
export function resolveAttachments(paths: string[]): string[] {
  return paths.map((p) => {
    const abs = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    if (!isAbsolute(abs)) throw new Error(`Attach files by absolute path: ${p}`)
    if (/[\n\r]/.test(abs))
      throw new Error(`A file name with a line break cannot be attached: ${abs}`)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      throw new Error(`No such file to attach: ${abs}`)
    }
    if (!st.isFile()) throw new Error(`Not a file, so it cannot be attached: ${abs}`)
    if (st.size > 25 * 1024 * 1024) throw new Error(`Too large to attach (over 25 MB): ${abs}`)
    return abs
  })
}

export function mailConnected(): boolean {
  return process.platform === 'darwin' && kvGet(KEY) === '1'
}

export function mailStatus(): MailConnectionStatus {
  return { supported: process.platform === 'darwin', connected: mailConnected() }
}

/** The osascript arguments for one request: JXA for reading, AppleScript to write. */
function scriptArgs(input: { op: string } & Record<string, unknown>): string[] {
  if (input.op !== 'draft' && input.op !== 'send')
    return ['-l', 'JavaScript', '-e', MAIL_SCRIPT, JSON.stringify(input)]
  const list = (v: unknown): string => (Array.isArray(v) ? v.map(String).join('\n') : '')
  return [
    '-e',
    COMPOSE_SCRIPT,
    input.op,
    String(input.subject ?? ''),
    String(input.body ?? ''),
    String(input.html ?? ''),
    list(input.to),
    list(input.cc),
    list(input.bcc),
    list(input.attachments)
  ]
}

function runMail(input: { op: string } & Record<string, unknown>): Promise<unknown> {
  const startedGeneration = generation
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      scriptArgs(input),
      { timeout: input.op === 'connect' ? 120_000 : 30_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Never echo the command: it contains draft text and recipient addresses.
          const denied = /-1743|not authorized|not permitted/i.test(stderr)
          if (denied && startedGeneration === generation) kvSet(KEY, '0')
          reject(
            new Error(
              denied
                ? 'Mail permission was denied. Enable Superagent → Mail in System Settings → Privacy & Security → Automation, then Connect again.'
                : error.killed
                  ? input.op === 'connect'
                    ? 'Mail did not respond. Check for a macOS permission prompt or open Mail, then try Connect again.'
                    : input.op === 'draft'
                      ? 'Mail took too long to respond. A draft may already have been saved; check Drafts before retrying.'
                      : input.op === 'send'
                        ? 'Mail took too long to respond. The message may already have been sent; check Sent before retrying.'
                        : 'Mail took too long to respond. Check Mail and try again.'
                  : 'Mail could not complete the request. Check the account and mailbox in Mail, then try again.'
            )
          )
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error('Mail returned an unreadable response.'))
        }
      }
    )
  })
}

// Disconnect invalidates a connect probe that is still awaiting the macOS dialog.
let generation = 0
export async function connectMail(): Promise<MailConnectionStatus> {
  if (process.platform !== 'darwin')
    return { ...mailStatus(), error: 'Apple Mail is available on macOS.' }
  const attempt = ++generation
  try {
    await runMail({ op: 'connect' })
    if (attempt === generation) kvSet(KEY, '1')
    return mailStatus()
  } catch (error) {
    if (attempt === generation) kvSet(KEY, '0')
    return { ...mailStatus(), error: (error as Error).message }
  }
}
export function disconnectMail(): MailConnectionStatus {
  generation++
  kvSet(KEY, '0')
  return mailStatus()
}

export async function callMail(op: keyof typeof mailSchemas, input: unknown): Promise<unknown> {
  if (!mailConnected())
    throw new Error(
      'Apple Mail is disconnected. Connect it in Settings → Connections, then start a new chat.'
    )
  const data = mailSchemas[op].parse(input)
  if (op === 'search') {
    const search = data as z.infer<typeof mailSchemas.search>
    if (!!search.accountId !== !!search.mailboxPath)
      throw new Error('Provide both accountId and mailboxPath, or neither to search all inboxes.')
  }
  if (op === 'draft' || op === 'send') {
    const msg = data as z.infer<typeof mailSchemas.send>
    msg.attachments = resolveAttachments(msg.attachments)
  }
  const current = generation
  const result = await runMail({ ...data, op })
  if (current !== generation || !mailConnected())
    throw new Error('Apple Mail was disconnected during this request. Its result was discarded.')
  return result
}

export function registerMailIpc(): void {
  ipcMain.handle('mail:status', mailStatus)
  ipcMain.handle('mail:connect', connectMail)
  ipcMain.handle('mail:disconnect', disconnectMail)
  ipcMain.handle('mail:permissions', () =>
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
  )
}
