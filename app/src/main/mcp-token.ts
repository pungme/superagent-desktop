import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Proof that a call to the tool server comes from the conversation it names.
 *
 * Every agent is given the server's address, and the address names its own
 * workspace and chat (?ws=…&chat=…). An agent could write a different chat id
 * into it. For most tools that only means acting in another chat's browser
 * pane; for computer use it would mean borrowing another conversation's yes.
 * So the address also carries a token made from the ids with a key that never
 * leaves this process, and the tools that need it check it.
 */

const key = randomBytes(32)

export function chatToken(workspaceId: string, chatId = '', secret: Buffer = key): string {
  return createHmac('sha256', secret)
    .update(`${workspaceId}\n${chatId}`)
    .digest('base64url')
    .slice(0, 32)
}

/** Whether a token is the one this process gave out for these ids. */
export function chatTokenValid(
  token: string | null | undefined,
  workspaceId: string,
  chatId = '',
  secret: Buffer = key
): boolean {
  if (!token) return false
  const want = Buffer.from(chatToken(workspaceId, chatId, secret))
  const got = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}
