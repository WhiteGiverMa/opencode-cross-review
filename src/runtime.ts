import { resolveConfig, isRecord, type Config } from "./config"
import { formatModelRef, readModelRef } from "./model-ref"
import {
  checkAvailability,
  configWarning,
  findMapping,
  matchesNative,
  unavailableWarning,
  type AvailableModel,
} from "./policy"

export type HostSession = {
  readonly parentID?: unknown
  readonly fork?: unknown
  readonly agent?: unknown
  readonly model?: unknown
}

export type HostAgent = {
  readonly id: unknown
  readonly mode: unknown
  readonly hidden?: unknown
  readonly model?: unknown
}

export type HostModel = AvailableModel

export type Host = {
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<HostSession>
  }
  readonly agent: {
    list(): Promise<{ readonly data: readonly HostAgent[] }>
  }
  readonly model: {
    list(): Promise<{ readonly data: readonly HostModel[] }>
    default(): Promise<{ readonly data: HostModel | null }>
  }
  readonly tool: {
    hookBefore(callback: (event: BeforeEvent) => Promise<void> | void): Promise<HookRegistration>
    hookAfter(callback: (event: AfterEvent) => Promise<void> | void): Promise<HookRegistration>
  }
}

export type HookRegistration = {
  dispose(): Promise<void> | void
}

export type BeforeEvent = {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  input: unknown
}

export type ToolContent =
  | string
  | undefined
  | readonly { readonly type: string; readonly text?: string }[]

export type ToolResult = {
  readonly output?: unknown
  readonly content?: ToolContent
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type AfterEvent = BeforeEvent &
  (
    | { readonly status: "completed"; result: ToolResult }
    | { readonly status: "error"; error: unknown }
  )

type PendingWarning = {
  readonly text: string
  readonly kind: "config" | "runtime"
}

const MAX_PENDING = 256
const MAX_WARNED_SESSIONS = 1024
const MAX_LOGGED_ERRORS = 64

export type CrossReview = {
  before(event: BeforeEvent): Promise<void>
  after(event: AfterEvent): void
  dispose(): void
}

export type CrossReviewHandle = {
  readonly crossReview: CrossReview
  readonly registrations: readonly HookRegistration[]
}

/**
 * Registers the v2 cross-review behavior. `undefined` means the options
 * disabled the plugin, in which case the host must register no hooks at all.
 */
export async function registerCrossReview(host: Host, options: unknown): Promise<CrossReviewHandle | undefined> {
  const resolution = resolveConfig(options)
  if (resolution.kind === "disabled") {
    return undefined
  }

  const crossReview = createCrossReview(host, resolution)
  const registrations = [
    await host.tool.hookBefore((event) => crossReview.before(event)),
    await host.tool.hookAfter((event) => crossReview.after(event)),
  ]

  return { crossReview, registrations }
}

export function createCrossReview(
  host: Host,
  resolution: ReturnType<typeof resolveConfig>,
): CrossReview {
  if (resolution.kind === "disabled") {
    return {
      before: async () => {},
      after: () => {},
      dispose: () => {},
    }
  }

  const pending = new Map<string, PendingWarning>()
  const warnedSessions = new Set<string>()
  const loggedErrors = new Set<string>()

  const logOnce = (message: string) => {
    if (loggedErrors.has(message)) return
    loggedErrors.add(message)
    if (loggedErrors.size > MAX_LOGGED_ERRORS) {
      const oldest = loggedErrors.values().next().value
      if (oldest !== undefined) loggedErrors.delete(oldest)
    }
    console.error(`[cross-review] ${message}`)
  }

  const remember = (event: BeforeEvent, text: string, kind: PendingWarning["kind"]) => {
    pending.set(event.id, { text, kind })
    if (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
  }

  if (resolution.kind === "invalid") {
    logOnce(resolution.error)
  }

  const before = async (event: BeforeEvent) => {
    if (event.tool.toLowerCase() !== "subagent") return

    const input = event.input
    if (!isRecord(input)) return

    if (resolution.kind === "invalid") {
      if (warnedSessions.has(event.sessionID)) return
      remember(event, configWarning(resolution.error), "config")
      return
    }

    const config = resolution.config
    if (readAgentID(input.agent) !== config.reviewer) return

    const requestedModel = input.model
    if (requestedModel !== undefined && requestedModel !== null) {
      if (typeof requestedModel !== "string") return
      if (requestedModel.length > 0) return
    }

    const session = await host.session.get({ sessionID: event.sessionID }).catch(() => undefined)
    if (session === undefined) return
    if (session.parentID !== undefined && session.fork === undefined) return

    const agents = await host.agent.list().then((response) => response.data).catch(() => undefined)
    if (agents === undefined) return
    const driverAgentID = readAgentID(session.agent) ?? defaultAgentID(agents)
    if (driverAgentID !== config.driver) return

    const driverAgent = agents.find((agent) => readAgentID(agent.id) === config.driver)
    const reviewerAgent = agents.find((agent) => readAgentID(agent.id) === config.reviewer)
    const agentError = validateAgents(config, driverAgent, reviewerAgent)
    if (agentError !== undefined) {
      logOnce(agentError)
      if (warnedSessions.has(event.sessionID)) return
      remember(event, configWarning(agentError), "config")
      return
    }

    const defaultModel = await host.model.default().then((response) => response.data).catch(() => undefined)
    const driverModel =
      readModelRef(session.model) ??
      readModelRef(driverAgent?.model) ??
      readModelRef(defaultModel)
    if (driverModel === undefined) return

    const mapping = findMapping(config, driverModel)
    if (mapping === undefined) return

    const available = await host.model.list().then((response) => response.data).catch(() => undefined)
    if (available === undefined) return
    const availability = checkAvailability(mapping, available)
    if (!availability.ok) {
      remember(event, unavailableWarning(mapping, availability), "runtime")
      return
    }

    const native = readModelRef(reviewerAgent?.model) ?? readModelRef(session.model)
    if (matchesNative(mapping, native)) return

    event.input = { ...input, model: formatModelRef(mapping.reviewer) }
  }

  const after = (event: AfterEvent) => {
    const warning = pending.get(event.id)
    if (warning === undefined) return
    pending.delete(event.id)
    if (event.status !== "completed") return
    event.result = withWarning(event.result, warning.text)
    if (warning.kind === "config") warnOnce(event.sessionID)
  }

  return {
    before,
    after,
    dispose: () => {
      pending.clear()
      warnedSessions.clear()
      loggedErrors.clear()
    },
  }

  function warnOnce(sessionID: string) {
    warnedSessions.add(sessionID)
    if (warnedSessions.size <= MAX_WARNED_SESSIONS) return
    const oldest = warnedSessions.values().next().value
    if (oldest !== undefined) warnedSessions.delete(oldest)
  }
}

function validateAgents(
  config: Config,
  driver: HostAgent | undefined,
  reviewer: HostAgent | undefined,
): string | undefined {
  if (driver === undefined) return `driver agent "${config.driver}" does not exist.`
  if (reviewer === undefined) return `reviewer agent "${config.reviewer}" does not exist.`

  const driverMode = readAgentMode(driver.mode)
  if (driverMode !== "primary" && driverMode !== "all") {
    return `driver agent "${config.driver}" must use mode "primary" or "all", found "${driverMode ?? "unknown"}".`
  }

  const reviewerMode = readAgentMode(reviewer.mode)
  if (reviewerMode !== "subagent" && reviewerMode !== "all") {
    return `reviewer agent "${config.reviewer}" must use mode "subagent" or "all", found "${reviewerMode ?? "unknown"}".`
  }

  return undefined
}

function defaultAgentID(agents: readonly HostAgent[]): string | undefined {
  for (const agent of agents) {
    if (readAgentMode(agent.mode) === "subagent") continue
    if (agent.hidden === true) continue
    const id = readAgentID(agent.id)
    if (id !== undefined) return id
  }
  return undefined
}

function readAgentID(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

function readAgentMode(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

function withWarning(result: ToolResult, warning: string): ToolResult {
  const content = result.content
  if (typeof content === "string") {
    return { ...result, content: content.length === 0 ? warning : `${content}\n\n${warning}` }
  }
  if (content === undefined) {
    return { ...result, content: warning }
  }
  return { ...result, content: [...content, { type: "text", text: warning }] }
}


