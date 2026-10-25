import { describe, expect, it } from "bun:test"
import { resolveConfig } from "../src/config"
import { formatModelRef, parseModelRef, readModelRef, sameModel, sameModelRef } from "../src/model-ref"
import { checkAvailability, configWarning, findMapping, matchesNative, unavailableWarning } from "../src/policy"

describe("model references", () => {
  it("parses provider/model and optional variant", () => {
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    })
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash#max")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
      variant: "max",
    })
  })

  it("keeps slashes inside the model id", () => {
    expect(parseModelRef("sakiko/zcode/glm-5.3")).toEqual({
      providerID: "sakiko",
      id: "zcode/glm-5.3",
    })
  })

  it("rejects malformed references", () => {
    expect(() => parseModelRef("model-only")).toThrow(/Invalid model reference/)
    expect(() => parseModelRef("/model")).toThrow(/Invalid model reference/)
    expect(() => parseModelRef("provider/")).toThrow(/Invalid model reference/)
    expect(() => parseModelRef("provider/model#")).toThrow(/Invalid model reference/)
    expect(() => parseModelRef("provider/model#a#b")).toThrow(/Invalid model reference/)
    expect(() => parseModelRef("pro#vider/model")).toThrow(/Invalid model reference/)
  })

  it("formats and compares refs", () => {
    expect(formatModelRef(parseModelRef("p/m#max"))).toBe("p/m#max")
    const a = parseModelRef("p/m#max")
    const b = parseModelRef("p/m#min")
    expect(sameModel(a, b)).toBe(true)
    expect(sameModelRef(a, b)).toBe(false)
    expect(readModelRef({ providerID: "p", id: "m", variant: "max" })).toEqual(a)
    expect(readModelRef({ providerID: "", id: "m" })).toBeUndefined()
  })
})

describe("resolveConfig", () => {
  const base = {
    driver: "meidocho",
    reviewer: "oracle",
    mappings: [{ driver: "p/driver", reviewer: "p/reviewer" }],
  }

  it("resolves a ready config", () => {
    const result = resolveConfig(base)
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    expect(result.config.driver).toBe("meidocho")
    expect(result.config.mappings).toHaveLength(1)
  })

  it("is disabled by enabled: false", () => {
    expect(resolveConfig({ ...base, enabled: false })).toEqual({ kind: "disabled" })
  })

  it("rejects missing options", () => {
    expect(resolveConfig(undefined).kind).toBe("invalid")
    expect(resolveConfig([]).kind).toBe("invalid")
  })

  it("rejects a non-boolean enabled", () => {
    expect(resolveConfig({ ...base, enabled: "yes" }).kind).toBe("invalid")
  })

  it("rejects the same driver and reviewer agent", () => {
    expect(resolveConfig({ ...base, reviewer: "meidocho" }).kind).toBe("invalid")
  })

  it("rejects an empty mappings array", () => {
    expect(resolveConfig({ ...base, mappings: [] }).kind).toBe("invalid")
  })

  it("rejects a driver mapped to two different reviewers", () => {
    const result = resolveConfig({
      ...base,
      mappings: [
        { driver: "p/driver", reviewer: "p/reviewer" },
        { driver: "p/driver", reviewer: "p/other" },
      ],
    })
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.error).toMatch(/conflicts/)
    }
  })

  it("dedupes an identical mapping", () => {
    const result = resolveConfig({
      ...base,
      mappings: [
        { driver: "p/driver", reviewer: "p/reviewer" },
        { driver: "p/driver", reviewer: "p/reviewer" },
      ],
    })
    expect(result.kind).toBe("ready")
    if (result.kind === "ready") {
      expect(result.config.mappings).toHaveLength(1)
    }
  })

  it("allows many drivers to share one reviewer and reciprocal mappings", () => {
    const result = resolveConfig({
      ...base,
      mappings: [
        { driver: "p/a", reviewer: "p/x" },
        { driver: "p/b", reviewer: "p/x" },
        { driver: "p/x", reviewer: "p/a" },
      ],
    })
    expect(result.kind).toBe("ready")
    if (result.kind === "ready") {
      expect(result.config.mappings).toHaveLength(3)
    }
  })
})

describe("policy", () => {
  const mapping = { driver: parseModelRef("p/driver"), reviewer: parseModelRef("p/reviewer#max") }
  const config = { driver: "d", reviewer: "r", mappings: [mapping] }

  it("finds mappings by model identity, ignoring the variant", () => {
    expect(findMapping(config, parseModelRef("p/driver#min"))).toBe(mapping)
    expect(findMapping(config, parseModelRef("p/other"))).toBeUndefined()
  })

  it("accepts a fully available mapping", () => {
    expect(
      checkAvailability(mapping, [
        { providerID: "p", id: "driver" },
        { providerID: "p", id: "reviewer", variants: [{ id: "max" }] },
      ]),
    ).toEqual({ ok: true })
  })

  it("reports an unavailable driver model", () => {
    expect(checkAvailability(mapping, [{ providerID: "p", id: "reviewer", variants: [{ id: "max" }] }])).toEqual({
      ok: false,
      side: "driver",
      model: mapping.driver,
      reason: "model",
    })
  })

  it("reports an unavailable reviewer variant", () => {
    expect(
      checkAvailability(mapping, [
        { providerID: "p", id: "driver" },
        { providerID: "p", id: "reviewer", variants: [{ id: "min" }] },
      ]),
    ).toEqual({
      ok: false,
      side: "reviewer",
      model: mapping.reviewer,
      reason: "variant",
    })
  })

  it("matches the native reviewer model only with the same variant", () => {
    expect(matchesNative(mapping, parseModelRef("p/reviewer#max"))).toBe(true)
    expect(matchesNative(mapping, parseModelRef("p/reviewer"))).toBe(false)
  })

  it("writes English warnings with the mapping and fallback", () => {
    const policyWarning = unavailableWarning(mapping, {
      ok: false,
      side: "reviewer",
      model: mapping.reviewer,
      reason: "variant",
    })
    expect(policyWarning).toContain("[cross-review]")
    expect(policyWarning).toContain('mapping "p/driver" -> "p/reviewer#max"')
    expect(policyWarning).toContain("reviewer variant")
    expect(policyWarning).toContain("native reviewer model resolution")

    const disabled = configWarning("driver agent \"meidocho\" does not exist.")
    expect(disabled).toContain("[cross-review]")
    expect(disabled).toContain("does not exist")
  })
})
