/**
 * Whether an option picked from an agent's question is sent with that
 * question quoted.
 *
 * Bare, "Yes, delete it" means something only while the question is the last
 * thing either side said and the agent is waiting on it. Once the user has
 * written anything since, or the agent is already at work on something else,
 * the answer arrives out of place and has to say what it answers.
 */
export function answerNeedsQuestion(
  /** The conversation's messages, oldest first: who said each, and its id. */
  messages: readonly { id: string; role: 'user' | 'assistant' }[],
  questionId: string,
  /** A turn is running: the agent has moved on from the question. */
  working: boolean
): boolean {
  const last = messages[messages.length - 1]
  return working || !last || last.id !== questionId
}
