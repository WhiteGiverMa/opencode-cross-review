export type ModelRef = {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export function parseModelRef(input: string): ModelRef {
  const providerEnd = input.indexOf("/")
  if (providerEnd <= 0) {
    throw new Error(`Invalid model reference "${input}": expected "providerID/modelID" or "providerID/modelID#variant".`)
  }

  const providerID = input.slice(0, providerEnd)
  const variantStart = input.indexOf("#", providerEnd + 1)
  const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)

  if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#")))) {
    throw new Error(`Invalid model reference "${input}": expected "providerID/modelID" or "providerID/modelID#variant".`)
  }

  return {
    providerID,
    id,
    ...(variant === undefined ? {} : { variant }),
  }
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}${ref.variant === undefined ? "" : `#${ref.variant}`}`
}

/** Model identity used for mapping lookup. Variants select a capability, not a different model. */
export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.id === b.id
}

/** Full reference equality, including the variant. */
export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return sameModel(a, b) && a.variant === b.variant
}

export function readModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  const record = value as Record<string, unknown>
  const providerID = record.providerID
  const id = record.id
  if (typeof providerID !== "string" || providerID.length === 0) return undefined
  if (typeof id !== "string" || id.length === 0) return undefined

  const variant = record.variant
  return {
    providerID,
    id,
    ...(typeof variant === "string" && variant.length > 0 ? { variant } : {}),
  }
}
