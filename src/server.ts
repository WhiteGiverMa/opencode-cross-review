import type { Cleanup, Context as PluginContext } from "@opencode/plugin/promise/plugin"
import {
  createCrossReview,
  registerCrossReview,
  type AfterEvent,
  type BeforeEvent,
  type Host,
  type HostAgent,
  type HostModel,
  type HostSession,
  type ToolContent,
  type ToolResult,
} from "./runtime"

export const id = "o3p.agent.cross-review"

async function setup(ctx: PluginContext): Promise<Cleanup | undefined> {
  const handle = await registerCrossReview(createHost(ctx), ctx.options)
  if (handle === undefined) return

  return async () => {
    handle.crossReview.dispose()
    for (const registration of handle.registrations) {
      await registration.dispose()
    }
  }
}

const pluginModule = { id, setup }

export default pluginModule

function createHost(ctx: PluginContext): Host {
  return {
    session: {
      get: async (input) => readSession(await ctx.session.get(input)),
    },
    agent: {
      list: async () => {
        const response = await ctx.agent.list()
        return { data: response.data.map((agent) => readAgent(agent)) }
      },
    },
    model: {
      list: async () => {
        const response = await ctx.model.list()
        return { data: response.data.map((model) => readModel(model)) }
      },
      default: async () => {
        const response = await ctx.model.default()
        return { data: response.data === null ? null : readModel(response.data) }
      },
    },
    tool: {
      hookBefore: (callback) =>
        ctx.tool.hook("execute.before", (event) => callback(event)),
      hookAfter: (callback) =>
        ctx.tool.hook("execute.after", (event) => callback(event)),
    },
  }
}

function readSession(session: {
  readonly parentID?: unknown
  readonly fork?: unknown
  readonly agent?: unknown
  readonly model?: unknown
}): HostSession {
  return {
    parentID: session.parentID,
    fork: session.fork,
    agent: session.agent,
    model: session.model,
  }
}

function readAgent(agent: {
  readonly id: unknown
  readonly mode: unknown
  readonly hidden?: unknown
  readonly model?: unknown
}): HostAgent {
  return {
    id: String(agent.id),
    mode: String(agent.mode),
    hidden: agent.hidden === true,
    model: agent.model,
  }
}

function readModel(model: {
  readonly providerID: unknown
  readonly id: unknown
  readonly variants?: readonly { readonly id: unknown }[]
}): HostModel {
  return {
    providerID: String(model.providerID),
    id: String(model.id),
    variants: model.variants?.map((variant) => ({ id: String(variant.id) })),
  }
}

export { createCrossReview, registerCrossReview }
export type { AfterEvent, BeforeEvent, Host, HostAgent, HostModel, HostSession, ToolContent, ToolResult }
export { resolveConfig } from "./config"
export { formatModelRef, parseModelRef, readModelRef, sameModel, sameModelRef } from "./model-ref"
export { checkAvailability, configWarning, findMapping, matchesNative, unavailableWarning } from "./policy"
export type { Config, ConfigResolution, Mapping } from "./config"
export type { Availability, AvailabilityFailure, AvailableModel } from "./policy"
export type { ModelRef } from "./model-ref"
