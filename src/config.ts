import { formatModelRef, parseModelRef, sameModelRef, type ModelRef } from "./model-ref"

export type Mapping = {
  readonly driver: ModelRef
  readonly reviewer: ModelRef
}

export type Config = {
  readonly driver: string
  readonly reviewer: string
  readonly mappings: readonly Mapping[]
}

export type ConfigResolution =
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "ready"; readonly config: Config }

export function resolveConfig(options: unknown): ConfigResolution {
  if (!isRecord(options)) {
    return invalid("options must be an object with driver, reviewer and mappings.")
  }

  const enabled = options.enabled ?? true
  if (typeof enabled !== "boolean") {
    return invalid("enabled must be a boolean.")
  }
  if (!enabled) {
    return { kind: "disabled" }
  }

  const driver = readName(options.driver, "driver")
  if (typeof driver !== "string") return invalid(driver.error)
  const reviewer = readName(options.reviewer, "reviewer")
  if (typeof reviewer !== "string") return invalid(reviewer.error)
  if (driver === reviewer) {
    return invalid("driver and reviewer must be different agents.")
  }

  if (!Array.isArray(options.mappings) || options.mappings.length === 0) {
    return invalid("mappings must be a non-empty array.")
  }

  const mappings: Mapping[] = []
  const byDriver = new Map<string, Mapping>()

  for (let index = 0; index < options.mappings.length; index += 1) {
    const raw = options.mappings[index]
    if (!isRecord(raw)) {
      return invalid(`mappings[${index}] must be an object with driver and reviewer.`)
    }

    const rawDriver = readName(raw.driver, `mappings[${index}].driver`)
    if (typeof rawDriver !== "string") return invalid(rawDriver.error)
    const rawReviewer = readName(raw.reviewer, `mappings[${index}].reviewer`)
    if (typeof rawReviewer !== "string") return invalid(rawReviewer.error)

    let mapping: Mapping
    try {
      mapping = {
        driver: parseModelRef(rawDriver),
        reviewer: parseModelRef(rawReviewer),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return invalid(`mappings[${index}]: ${message}`)
    }

    const previous = byDriver.get(modelKey(mapping.driver))
    if (previous !== undefined) {
      if (!sameModelRef(previous.reviewer, mapping.reviewer)) {
        return invalid(
          `mappings[${index}] conflicts with an earlier entry: driver "${formatModelRef(mapping.driver)}" already maps to "${formatModelRef(previous.reviewer)}", cannot also map to "${formatModelRef(mapping.reviewer)}".`,
        )
      }
      continue
    }

    byDriver.set(modelKey(mapping.driver), mapping)
    mappings.push(mapping)
  }

  return {
    kind: "ready",
    config: {
      driver,
      reviewer,
      mappings,
    },
  }
}

function readName(value: unknown, field: string): string | { readonly error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${field} must be a non-empty string.` }
  }
  return value.trim()
}

function modelKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}`
}

function invalid(error: string): ConfigResolution {
  return { kind: "invalid", error }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
