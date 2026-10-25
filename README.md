# opencode-cross-review

[English](README.en.md) | **简体中文**

一个 OpenCode v2 插件：按**有向模型映射**给领航员子代理换模型。驾驶员会话当前用 A 模型时，调用配置好的领航员子代理会自动落到 B 模型；映射关系是 `A -> B`，不是无序对。

- 只处理原生 `subagent` 工具，只动配置里的领航员 agent。
- 只对配置的驾驶员 agent、且当前会话是顶层会话时生效。
- 主代理显式传入 `model` 时完全不碰。
- 映射里的任意一侧模型不可用，就不注入，回退 OpenCode 原生解析，并把警告追加到这次 subagent 的工具结果里。
- `enabled: false` 时不注册任何钩子。

运行时插件 ID：`o3p.agent.cross-review`。

## 兼容性

| 宿主 | 版本 | 入口 |
| --- | --- | --- |
| OpenCode v2 | `@opencode/plugin` 2.1.2（实测 2.1.2） | 包根 / `server.js` / `setup()` |

仅支持 v2。插件不创建 agent，也不修改 agent 配置。

## 配置

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-cross-review",
      "options": {
        "enabled": true,
        "driver": "your-main-agent",
        "reviewer": "your-subagent",
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

首次使用先构建：

```bash
cd /absolute/path/to/opencode-cross-review
bun install
bun run build
```

`package` 指向仓库根即可，根目录的 `server.js` 会转发到 `dist/server.js`。

`package` 的路径由 OpenCode 解析，不是本插件的选项：

- `./...` / `../...`：相对**配置文件所在目录**解析。
- 绝对路径：Linux/macOS 写 `/absolute/path/...`；Windows 写 `C:/path/...`（JSON 里也可以写转义的 `C:\\path\\...`）；WSL 写 `/mnt/c/...`。
- `~/...` 在 `plugins[].package` 里不会展开，请写绝对路径。构建命令里的 `~` 由 shell 展开，和配置里的 `package` 不是一回事。
- 裸相对名（如 `opencode-cross-review`）会被当成 npm 包名；本地目录必须带 `./` 或 `../`。
- `file://` URL 也支持，会被转换成本地路径。

字段：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 默认 `true`。`false` 时插件不注册任何行为。 |
| `driver` | 驾驶员 agent ID，必须是 `primary` 或 `all` 模式。 |
| `reviewer` | 领航员 agent ID，必须是 `subagent` 或 `all` 模式。 |
| `mappings` | 非空数组，每项 `{ driver, reviewer }`，两边都是模型引用。 |

模型引用格式为 `providerID/modelID` 或 `providerID/modelID#variant`。

## 映射规则

- 多个驾驶员模型可以映射到同一个领航员模型。
- 一个驾驶员模型只能映射到一个领航员模型；映射到不同领航员会被判为配置错误。
- `A -> B` 与 `B -> A` 可以同时存在。
- 同一个模型可以在一项里当驾驶员、在另一项里当领航员。
- 完全相同的映射重复写两次会静默去重。
- 匹配驾驶员模型时忽略 variant；`#variant` 只在注入时保留。
- 若映射目标正好等于领航员原生会用的模型（`reviewer agent model ?? 父会话模型`），跳过注入，避免无意义写入。

## 生效条件

一次 `subagent` 调用必须同时满足：

1. 工具名是 `subagent`；
2. 当前会话是顶层会话（`parentID` 为空，或它是 fork 会话）；
3. 当前会话的 agent 是配置的 `driver`；会话没有显式 agent 时，按 OpenCode 的默认主代理解析；
4. `input.agent` 是配置的 `reviewer`；
5. `input.model` 未填写（`undefined` 或空字符串）；
6. 驾驶员模型命中某条映射：`session.model ?? driver agent model ?? 全局默认模型`。

命中后，插件把 `input.model` 写成映射里的领航员模型，OpenCode 原生 `subagent` 工具按 `input.model ?? agent.model ?? parent.model` 解析，因此只影响这次领航员子会话。

## 不可用与回退

可用性取自 OpenCode 当时启用的模型目录（`model.list()`）：

- 映射的驾驶员模型或领航员模型不在目录里 → 该映射不可用。
- 映射写了 variant 但该 variant 不存在 → 该映射不可用。

命中不可用映射时：

- 不注入 `input.model`，让 OpenCode 走原生领航员模型解析；
- 在这次 subagent 的工具结果末尾追加一行 `[cross-review]` 警告，包含映射、失效侧和回退说明；
- 每次实际回退都会提示。

配置错误（options 结构错、agent 不存在、mode 不对、一个驾驶员映射多个领航员等）：

- 插件禁用模型路由，不注入任何模型；
- 通过 `console.error` 记录一条；
- 每个会话首次调用 `subagent` 时在工具结果里提示一次，之后同一会话不再重复。

## 不在范围内

- 不注入审核提示词或审核流程；提示词归属由另一个插件负责。
- 不创建、修改或删除 agent。
- 不处理 `task`、`write`、`edit` 等其他工具。
- 不覆盖主代理显式传入的 `model`。
- 不做 TUI toast；警告只进入 subagent 工具结果和 server 日志。

## 验证

- `tsc --noEmit` 干净。
- `bun test`：41 个测试通过（配置解析、映射匹配、variant、可用性、回退、去重、嵌套会话、显式 model、清理）。
- `npm run build`：ESM `dist/server.js` + 类型声明。
- 隔离 OpenCode v2.1.2 实例手动 QA：
  - `deepseek-v4.1-flash -> deepseek-v4-pro` 命中，子会话模型为 `opencode-go/deepseek-v4-pro`；
  - 显式传 `model: opencode-go/deepseek-v4.1-flash`，子会话保持 flash；
  - 映射到不存在的模型，子会话回退原生 flash，工具结果出现 `[cross-review]` 警告；
  - 重复驾驶员映射不同领航员，工具结果出现配置错误，子会话回退原生；
  - `enabled: false`，子会话保持原生 flash，无警告。

## 许可

MIT。
