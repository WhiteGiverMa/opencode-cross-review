import { formatModelRef, sameModel, sameModelRef, type ModelRef } from "./model-ref"
import type { Config, Mapping } from "./config"

export type AvailableModel = {
  readonly providerID: string
  readonly id: string
  readonly variants?: readonly { readonly id: string }[]
}

export type AvailabilityFailure = {
  readonly ok: false
  readonly side: "driver" | "reviewer"
  readonly model: ModelRef
  readonly reason: "model" | "variant"
}

export type Availability = { readonly ok: true } | AvailabilityFailure

export function findMapping(config: Config, driver: ModelRef): Mapping | undefined {
  return config.mappings.find((mapping) => sameModel(mapping.driver, driver))
}

export function checkAvailability(
  mapping: Mapping,
  available: readonly AvailableModel[],
): Availability {
  const driver = checkSide("driver", mapping.driver, available)
  if (driver !== undefined) return driver
  const reviewer = checkSide("reviewer", mapping.reviewer, available)
  if (reviewer !== undefined) return reviewer
  return { ok: true }
}

function checkSide(
  side: AvailabilityFailure["side"],
  ref: ModelRef,
  available: readonly AvailableModel[],
): AvailabilityFailure | undefined {
  const model = available.find((entry) => entry.providerID === ref.providerID && entry.id === ref.id)
  if (model === undefined) {
    return { ok: false, side, model: ref, reason: "model" }
  }
  if (ref.variant !== undefined && !model.variants?.some((variant) => variant.id === ref.variant)) {
    return { ok: false, side, model: ref, reason: "variant" }
  }
  return undefined
}

export function matchesNative(mapping: Mapping, native: ModelRef | undefined): boolean {
  return native !== undefined && sameModelRef(mapping.reviewer, native)
}

export function unavailableWarning(mapping: Mapping, failure: AvailabilityFailure): string {
  const detail =
    failure.reason === "model"
      ? `${failure.side} model "${formatModelRef(failure.model)}" is not in the available catalog`
      : `${failure.side} variant "${failure.model.variant ?? ""}" is not available for "${formatModelRef(failure.model)}"`

  return [
    `[cross-review] Reviewer model was not switched: mapping "${formatModelRef(mapping.driver)}" -> "${formatModelRef(mapping.reviewer)}" is unavailable (${detail}).`,
    "Falling back to OpenCode's native reviewer model resolution.",
  ].join(" ")
}

export function configWarning(error: string): string {
  return [
    `[cross-review] Model routing is disabled: ${error}`,
    "Falling back to OpenCode's native reviewer model resolution.",
  ].join(" ")
}
