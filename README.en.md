# opencode-cross-review

**English** | [简体中文](README.md)

An OpenCode v2 plugin that routes a reviewer subagent's model through an explicit **directed mapping**. When the driver session uses model A, spawning the configured reviewer subagent lands on model B. The relation is `A -> B`, not an unordered pair.

- Handles only the native `subagent` tool and only the configured reviewer agent.
- Applies only to the configured driver agent and only in top-level sessions.
- Never touches an explicit `model` argument from the main agent.
- If either side of a mapping is unavailable, it does not inject, falls back to OpenCode's native resolution, and appends a warning to that subagent tool result.
- `enabled: false` registers no hooks at all.

Runtime plugin ID: `o3p.agent.cross-review`.

## Compatibility

| Host | Version | Entry |
| --- | --- | --- |
| OpenCode v2 | `@opencode/plugin` 2.1.2 (tested with 2.1.2) | package root / `server.js` / `setup()` |

v2 only. The plugin does not create agents or modify agent configuration.

## Configuration

```json
{
  "plugins": [
    {
      "package": "/home/celestia/proj/o3p/opencode-cross-review",
      "options": {
        "enabled": true,
        "driver": "meidocho",
        "reviewer": "oracle",
        "mappings": [
          {
            "driver": "opencode-go/deepseek-v4.1-flash",
            "reviewer": "opencode-go/deepseek-v4-pro"
          },
          {
            "driver": "opencode-go/glm-5.3",
            "reviewer": "opencode-go/deepseek-v4-pro"
          },
          {
            "driver": "opencode-go/deepseek-v4-pro",
            "reviewer": "opencode-go/deepseek-v4.1-flash"
          }
        ]
      }
    }
  ]
}
```

Build once before loading:

```bash
cd /home/celestia/proj/o3p/opencode-cross-review
bun install
bun run build
```

Point `package` at the repository root; the root `server.js` forwards to `dist/server.js`.

| Field | Description |
| --- | --- |
| `enabled` | Defaults to `true`. When `false`, the plugin registers no behavior. |
| `driver` | Driver agent ID. Must use `primary` or `all` mode. |
| `reviewer` | Reviewer agent ID. Must use `subagent` or `all` mode. |
| `mappings` | Non-empty array of `{ driver, reviewer }` model references. |

Model references use `providerID/modelID` or `providerID/modelID#variant`.

## Mapping rules

- Many driver models may share one reviewer model.
- One driver model may map to only one reviewer model; mapping it to different reviewers is a configuration error.
- `A -> B` and `B -> A` may coexist.
- The same model may be a driver in one entry and a reviewer in another.
- Duplicate identical mappings are silently deduplicated.
- Driver matching ignores the variant; `#variant` is preserved only on injection.
- If the mapping target equals the model the reviewer would natively use (`reviewer agent model ?? parent session model`), injection is skipped.

## When it applies

A `subagent` call must satisfy all of:

1. Tool name is `subagent`.
2. The current session is top-level (`parentID` is empty, or it is a fork).
3. The session agent is the configured `driver`; a session without an explicit agent resolves through OpenCode's default primary agent.
4. `input.agent` is the configured `reviewer`.
5. `input.model` is unset (`undefined` or an empty string).
6. The driver model matches a mapping: `session.model ?? driver agent model ?? global default model`.

On a match, the plugin writes `input.model` to the mapped reviewer model. The native `subagent` tool resolves `input.model ?? agent.model ?? parent.model`, so only that reviewer child session is affected.

## Unavailable mappings and fallback

Availability comes from the enabled model catalog (`model.list()`):

- The mapped driver or reviewer model is absent from the catalog.
- A mapped variant does not exist on that model.

When an unavailable mapping is hit:

- `input.model` is not injected; OpenCode uses its native reviewer model resolution.
- A `[cross-review]` warning is appended to the subagent tool result with the mapping, failing side, and fallback note.
- Every actual fallback warns.

Configuration errors (bad options shape, missing agent, wrong mode, one driver mapped to several reviewers, and so on):

- Model routing is disabled; nothing is injected.
- One `console.error` line is written.
- The first `subagent` call in each session gets a warning in its tool result; later calls in the same session stay quiet.

## Out of scope

- No review prompt or workflow injection; prompt ownership lives in another plugin.
- No agent creation, mutation, or deletion.
- No handling of `task`, `write`, `edit`, or other tools.
- No overriding an explicit `model` from the main agent.
- No TUI toast; warnings only enter the subagent tool result and the server log.

## Verification

- `tsc --noEmit` clean.
- `bun test`: 41 tests passing (config parsing, mapping lookup, variants, availability, fallback, dedupe, nested sessions, explicit model, cleanup).
- `npm run build`: ESM `dist/server.js` plus declarations.
- Manual QA on an isolated OpenCode v2.1.2 instance:
  - `deepseek-v4.1-flash -> deepseek-v4-pro` hit; the child session model was `opencode-go/deepseek-v4-pro`.
  - Explicit `model: opencode-go/deepseek-v4.1-flash`; the child stayed on flash.
  - Mapping to a missing model; the child fell back to native flash and the tool result carried a `[cross-review]` warning.
  - Duplicate driver mappings to different reviewers; the tool result reported the config error and the child fell back to native.
  - `enabled: false`; the child stayed on native flash with no warning.

## License

MIT.
