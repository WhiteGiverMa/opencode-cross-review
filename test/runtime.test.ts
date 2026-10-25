import { describe, expect, it } from "bun:test"
import { registerCrossReview, type AfterEvent, type BeforeEvent, type Host, type HostAgent, type HostModel } from "../src/runtime"

type Fixture = {
  sessions?: Record<string, { parentID?: string; fork?: unknown; agent?: string; model?: unknown }>
  agents?: HostAgent[]
  models?: HostModel[]
  defaultModel?: HostModel | null
}

function setup(fixture: Fixture = {}) {
  const before: Array<(event: BeforeEvent) => Promise<void> | void> = []
  const after: Array<(event: AfterEvent) => Promise<void> | void> = []

  const agents: HostAgent[] =
    fixture.agents ??
    [
      { id: "meidocho", mode: "primary", model: { providerID: "p", id: "driver" } },
      { id: "oracle", mode: "subagent" },
    ]
  const models: HostModel[] =
    fixture.models ??
    [
      { providerID: "p", id: "driver" },
      { providerID: "p", id: "reviewer" },
      { providerID: "p", id: "other" },
    ]
  const sessions = fixture.sessions ?? {
    root: { agent: "meidocho", model: { providerID: "p", id: "driver" } },
  }

  const host: Host = {
    session: {
      get: async ({ sessionID }) => {
        const session = sessions[sessionID]
        if (session === undefined) throw new Error(`Unknown session: ${sessionID}`)
        return session
      },
    },
    agent: {
      list: async () => ({ data: agents }),
    },
    model: {
      list: async () => ({ data: models }),
      default: async () => ({ data: fixture.defaultModel === undefined ? models[0] ?? null : fixture.defaultModel }),
    },
    tool: {
      hookBefore: async (callback) => {
        before.push(callback)
        return { dispose: () => {} }
      },
      hookAfter: async (callback) => {
        after.push(callback)
        return { dispose: () => {} }
      },
    },
  }

  const options = {
    driver: "meidocho",
    reviewer: "oracle",
    mappings: [{ driver: "p/driver", reviewer: "p/reviewer" }],
  }

  return { host, options, before, after }
}

async function runBefore(before: Array<(event: BeforeEvent) => Promise<void> | void>, event: BeforeEvent) {
  for (const callback of before) {
    await callback(event)
  }
}

async function runAfter(after: Array<(event: AfterEvent) => Promise<void> | void>, event: AfterEvent) {
  for (const callback of after) {
    await callback(event)
  }
  return event
}

function beforeEvent(overrides: Partial<BeforeEvent> = {}): BeforeEvent {
  return {
    tool: "subagent",
    sessionID: "root",
    id: "call-1",
    input: { agent: "oracle", prompt: "review this" },
    ...overrides,
  }
}

function afterEvent(input: unknown, result: { content?: string | readonly { type: string; text?: string }[] } = { content: "<subagent />" }): BeforeEvent & { status: "completed"; result: { content?: string | readonly { type: string; text?: string }[] } } {
  return {
    tool: "subagent",
    sessionID: "root",
    id: "call-1",
    input,
    status: "completed",
    result,
  }
}

describe("cross-review runtime", () => {
  it("registers no hooks when disabled", async () => {
    const { host, before, after } = setup()
    const handle = await registerCrossReview(host, { enabled: false })
    expect(handle).toBeUndefined()
    expect(before).toHaveLength(0)
    expect(after).toHaveLength(0)
  })

  it("injects the mapped reviewer model when the driver matches", async () => {
    const { host, options, before, after } = setup()
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBe("p/reviewer")

    const completed = afterEvent(event.input)
    await runAfter(after, completed)
    expect(completed.result.content).toBe("<subagent />")
  })

  it("does not touch an explicit model", async () => {
    const { host, options, before } = setup()
    await registerCrossReview(host, options)

    const event = beforeEvent({ input: { agent: "oracle", prompt: "x", model: "p/other" } })
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBe("p/other")
  })

  it("treats an empty model as unset", async () => {
    const { host, options, before } = setup()
    await registerCrossReview(host, options)

    const event = beforeEvent({ input: { agent: "oracle", prompt: "x", model: "" } })
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBe("p/reviewer")
  })

  it("ignores non-subagent tools and other agents", async () => {
    const { host, options, before } = setup()
    await registerCrossReview(host, options)

    const otherTool = beforeEvent({ tool: "write" })
    await runBefore(before, otherTool)
    expect((otherTool.input as { model?: string }).model).toBeUndefined()

    const otherAgent = beforeEvent({ input: { agent: "explore", prompt: "x" } })
    await runBefore(before, otherAgent)
    expect((otherAgent.input as { model?: string }).model).toBeUndefined()
  })

  it("ignores nested subagent sessions", async () => {
    const { host, options, before } = setup({
      sessions: {
        root: { agent: "meidocho", model: { providerID: "p", id: "driver" } },
        child: { parentID: "root", agent: "meidocho", model: { providerID: "p", id: "driver" } },
      },
    })
    await registerCrossReview(host, options)

    const event = beforeEvent({ sessionID: "child" })
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()
  })

  it("treats forked sessions as roots", async () => {
    const { host, options, before } = setup({
      sessions: {
        fork: { parentID: "root", fork: { sessionID: "root" }, agent: "meidocho", model: { providerID: "p", id: "driver" } },
      },
    })
    await registerCrossReview(host, options)

    const event = beforeEvent({ sessionID: "fork" })
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBe("p/reviewer")
  })

  it("ignores a session whose driver agent differs", async () => {
    const { host, options, before } = setup({
      sessions: { root: { agent: "plan", model: { providerID: "p", id: "driver" } } },
    })
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()
  })

  it("ignores a driver model that has no mapping", async () => {
    const { host, options, before } = setup({
      sessions: { root: { agent: "meidocho", model: { providerID: "p", id: "other" } } },
    })
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()
  })

  it("falls back and warns when the reviewer model is unavailable", async () => {
    const { host, options, before, after } = setup({
      models: [
        { providerID: "p", id: "driver" },
        { providerID: "p", id: "other" },
      ],
    })
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()

    const completed = afterEvent(event.input)
    await runAfter(after, completed)
    expect(completed.result.content).toContain("[cross-review]")
    expect(completed.result.content).toContain('mapping "p/driver" -> "p/reviewer"')
    expect(completed.result.content).toContain("native reviewer model resolution")
  })

  it("falls back and warns when the reviewer variant is unavailable", async () => {
    const { host, options, before, after } = setup({
      models: [
        { providerID: "p", id: "driver" },
        { providerID: "p", id: "reviewer", variants: [{ id: "min" }] },
      ],
    })
    await registerCrossReview(host, {
      ...options,
      mappings: [{ driver: "p/driver", reviewer: "p/reviewer#max" }],
    })

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()

    const completed = afterEvent(event.input)
    await runAfter(after, completed)
    expect(completed.result.content).toContain("reviewer variant")
  })

  it("injects a mapped variant when it is available", async () => {
    const { host, options, before } = setup({
      models: [
        { providerID: "p", id: "driver" },
        { providerID: "p", id: "reviewer", variants: [{ id: "max" }] },
      ],
    })
    await registerCrossReview(host, {
      ...options,
      mappings: [{ driver: "p/driver", reviewer: "p/reviewer#max" }],
    })

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBe("p/reviewer#max")
  })

  it("skips injection when the target equals the native reviewer model", async () => {
    const { host, options, before, after } = setup({
      agents: [
        { id: "meidocho", mode: "primary", model: { providerID: "p", id: "driver" } },
        { id: "oracle", mode: "subagent", model: { providerID: "p", id: "reviewer" } },
      ],
    })
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()

    const completed = afterEvent(event.input)
    await runAfter(after, completed)
    expect(completed.result.content).toBe("<subagent />")
  })

  it("reports a structural config error once per session", async () => {
    const { host, before, after } = setup()
    await registerCrossReview(host, {
      driver: "meidocho",
      reviewer: "oracle",
      mappings: [
        { driver: "p/driver", reviewer: "p/reviewer" },
        { driver: "p/driver", reviewer: "p/other" },
      ],
    })

    const first = beforeEvent()
    await runBefore(before, first)
    const firstAfter = afterEvent(first.input)
    await runAfter(after, firstAfter)
    expect(firstAfter.result.content).toContain("[cross-review]")
    expect(firstAfter.result.content).toContain("conflicts")

    const second = beforeEvent({ id: "call-2" })
    await runBefore(before, second)
    const secondAfter = afterEvent(second.input)
    await runAfter(after, secondAfter)
    expect(secondAfter.result.content).toBe("<subagent />")
  })

  it("retries a config warning if the first call failed", async () => {
    const { host, before, after } = setup()
    await registerCrossReview(host, {
      driver: "meidocho",
      reviewer: "oracle",
      mappings: [
        { driver: "p/driver", reviewer: "p/reviewer" },
        { driver: "p/driver", reviewer: "p/other" },
      ],
    })

    const first = beforeEvent()
    await runBefore(before, first)
    const failed: AfterEvent = {
      tool: "subagent",
      sessionID: "root",
      id: "call-1",
      input: first.input,
      status: "error",
      error: new Error("boom"),
    }
    await runAfter(after, failed)

    const second = beforeEvent({ id: "call-2" })
    await runBefore(before, second)
    const completed = {
      tool: "subagent",
      sessionID: "root",
      id: "call-2",
      input: second.input,
      status: "completed" as const,
      result: { content: "<subagent />" },
    }
    await runAfter(after, completed)
    expect(completed.result.content).toContain("[cross-review]")
  })

  it("warns once per session when the reviewer agent is missing", async () => {
    const { host, options, before, after } = setup({
      agents: [{ id: "meidocho", mode: "primary", model: { providerID: "p", id: "driver" } }],
    })
    await registerCrossReview(host, options)

    const first = beforeEvent()
    await runBefore(before, first)
    const firstAfter = afterEvent(first.input)
    await runAfter(after, firstAfter)
    expect(firstAfter.result.content).toContain("reviewer agent \"oracle\" does not exist")

    const second = beforeEvent({ id: "call-2" })
    await runBefore(before, second)
    const secondAfter = afterEvent(second.input)
    await runAfter(after, secondAfter)
    expect(secondAfter.result.content).toBe("<subagent />")
  })

  it("warns when the driver mode is not primary or all", async () => {
    const { host, options, before, after } = setup({
      agents: [
        { id: "meidocho", mode: "subagent", model: { providerID: "p", id: "driver" } },
        { id: "oracle", mode: "subagent", model: { providerID: "p", id: "reviewer" } },
      ],
    })
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    const completed = afterEvent(event.input)
    await runAfter(after, completed)
    expect(completed.result.content).toContain("must use mode")
  })

  it("warns when the reviewer mode is not subagent or all", async () => {
    const { host, options, before, after } = setup({
      agents: [
        { id: "meidocho", mode: "primary", model: { providerID: "p", id: "driver" } },
        { id: "oracle", mode: "primary", model: { providerID: "p", id: "reviewer" } },
      ],
    })
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    const completed = afterEvent(event.input)
    await runAfter(after, completed)
    expect(completed.result.content).toContain("must use mode")
  })

  it("does not modify the result when the subagent call failed", async () => {
    const { host, options, before, after } = setup({
      models: [{ providerID: "p", id: "driver" }],
    })
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    const failed: AfterEvent = {
      tool: "subagent",
      sessionID: "root",
      id: "call-1",
      input: event.input,
      status: "error",
      error: new Error("boom"),
    }
    await runAfter(after, failed)
    expect("result" in failed).toBe(false)
  })

  it("fails open when the agent catalog is unavailable", async () => {
    const { host, options, before } = setup()
    host.agent.list = async () => {
      throw new Error("agents unavailable")
    }
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()
  })

  it("fails open when the model catalog is unavailable", async () => {
    const { host, options, before } = setup()
    host.model.list = async () => {
      throw new Error("models unavailable")
    }
    await registerCrossReview(host, options)

    const event = beforeEvent()
    await runBefore(before, event)
    expect((event.input as { model?: string }).model).toBeUndefined()
  })

  it("disposes cleanly", async () => {
    const { host, options } = setup()
    const handle = await registerCrossReview(host, options)
    expect(handle).toBeDefined()
    handle?.crossReview.dispose()
    for (const registration of handle?.registrations ?? []) {
      await registration.dispose()
    }
  })
})
