import type { AgentProvider } from '../shared/agent-provider'

/**
 * The seam between "a chat is running" and "this particular CLI is running it".
 *
 * Nothing in this file knows about a flag, a wire format or a process. Each
 * backend lives entirely in its own directory — `claude/` drives a long-lived
 * `claude` process reading stream-json on stdin, `codex/` drives a `codex
 * app-server` over JSON-RPC — and neither imports the other. `agent.ts` above
 * them owns only what is genuinely shared: the session registry, which window
 * owns a session, the recap for a session that lost its memory, and the event
 * bus the renderer, the phone and the transcript all read.
 *
 * The practical rule this encodes: adding, changing or breaking a backend must
 * not be able to reach the other one. A Codex bug cannot regress Claude Code,
 * because no Codex code runs on a Claude chat's path.
 */

export interface AgentImage {
  mediaType: string
  data: string // base64
}

export interface AgentStartOptions {
  /**
   * Which agent CLI runs this chat. Absent means Claude — which is what every
   * chat written before there was a second backend was.
   */
  provider?: AgentProvider
  cwd?: string
  workspaceId?: string
  /** The conversation this session belongs to — stamped onto board cards. */
  chatId?: string
  mcpConfigPath?: string
  /** Resume a prior conversation by session id (so history/context persists). */
  resumeSessionId?: string | null
  /** Browser-first workspace: steer the agent to drive the visible browser. */
  browserProject?: boolean
  /**
   * How much the agent may do without asking. Superagent's four names; each
   * backend translates them into its own vocabulary (Claude's permission modes,
   * Codex's approval policy plus sandbox).
   */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'ask'
  /** Model to run on; '' / undefined = whatever the account defaults to. */
  model?: string
}

/** What a chat needs from whichever CLI is behind it. */
export interface AgentBackend {
  /**
   * Deliver a user message. `imagePaths` are the on-disk copies of `images`
   * (the caller saves them either way), for a backend that prefers file paths
   * to inline base64. False if the session is no longer accepting messages.
   */
  send(text: string, images: AgentImage[], imagePaths: string[]): boolean
  /** Ask the current generation to stop, keeping the session and its context. */
  interrupt(): void
  /**
   * Stop even mid-tool-call — a message sent during a 15-minute deploy must not
   * wait for the deploy. Resolves true once the session has genuinely ended.
   */
  hardInterrupt(): Promise<boolean>
  /** End the session for good. */
  kill(): void
  readonly writable: boolean
}

/**
 * How a backend talks back. It is handed one of these and calls it; it never
 * touches the session registry, the bus or a WebContents itself.
 */
export interface SessionHost {
  /** The live backend, as soon as it exists. Called once per session. */
  ready(backend: AgentBackend): void
  /** One stream-json event. Backends that speak another dialect translate first. */
  event(event: Record<string, unknown>): void
  stderr(text: string): void
  /** The session is over. `reason` is the one human line worth showing, if any. */
  exit(code: number, reason?: string): void
  /**
   * The recorded session could not be resumed and a fresh one is starting in its
   * place — so the conversation on screen has an agent behind it that remembers
   * none of it, and the next message needs a recap.
   */
  resumeLost(): void
}

/** Everything a backend is given beyond the user's own options. */
export interface SessionContext {
  /** Path to the MCP config file naming Superagent's own tool server. */
  mcpConfigPath?: string
}

/**
 * The second thing a backend implements: a routine run.
 *
 * A routine is headless and unattended — no streaming, no approvals, no
 * steering — so it does not need a session at all. Each backend runs one turn to
 * completion however it likes and reports the same outcome.
 */
export interface RoutineRunOptions {
  prompt: string
  /** Appended to the system prompt: how to behave with nobody watching. */
  systemPrompt: string
  cwd: string
  /** The offscreen browser pane this run drives; also the MCP scope id. */
  paneId: string
  /** Config file naming Superagent's tool server, for backends that take a file. */
  mcpConfigPath: string
  /** Same server as a URL, for backends that take it inline. */
  mcpUrl: string
  maxTurns: number
  timeoutMs: number
  /** Called as steps arrive, so the run viewer updates live rather than at the end. */
  onSteps: (steps: RoutineStep[]) => void
}

/** One entry in a routine run's transcript. */
export type RoutineStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input?: string }

export interface RoutineOutcome {
  ok: boolean
  summary: string
  steps: RoutineStep[]
  tokens: number
}
