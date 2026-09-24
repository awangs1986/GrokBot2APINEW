# 接入 Pi Coding Agent

## 结论与验证范围

使用 **`openai-responses`**，不需要增加 Chat Completions 接口，也不需要 Pi 扩展。
这是自定义 `grokbot` provider，不是 Pi 内置的 `xai` provider 或它的登录流程。

本仓库锁定 `@earendil-works/pi-coding-agent@0.87.1` 作为**开发/测试依赖**，
测试直接启动该包的真实 Pi CLI，不会调用你电脑上全局安装的 Pi。
安装/运行这组开发测试需要 **Node >= 22.19.0**；sidecar 自身仍无运行时 npm 依赖。
旧 `@mariozechner/pi-coding-agent` 版本和其他 Pi 分支未纳入本次契约测试。

已验证的本地链路：

```text
真实 Pi CLI → HTTP /v1/responses → sidecar 请求编码
           → 模拟 Grok Bot Connect/Protobuf 响应 → sidecar 解码/SSE
           → Pi 执行两个 read 工具 → 完整历史及结果回传 → 最终文本
```

还验证了交错的工具参数分片、文本与工具混合输出、会话 ID 稳定、限流错误和缺失结束帧错误。
**这不等于真实 Grok Bot 上游已经可用**：网络传输和账号凭据在契约测试中被替换。
真实账号权限、当前上游协议、模型可用性和刷新流程仍需在部署机器验证。

## 1. 启动 sidecar

先在项目目录准备 `.env`。不要覆盖已有配置：

```sh
# 仅首次创建；如果已有 .env，请直接编辑它。
cp -n .env.example .env
```

编辑 `.env`：设置强随机的 `GROKBOT2API_KEY`，并配置 Grok Bot 凭据提供方式
（`GROKBOT_CREDENTIALS_COMMAND` 或 `GROKBOT_CREDENTIALS_FILE` 等，见 README）。
两种 Key 不要混淆：

- `GROKBOT2API_KEY`：Pi 访问 sidecar 的共享密钥；不是 Grok Bot Token。
- Grok Bot access token / machine ID：只交给 sidecar 的凭据提供器，不放进 Pi 配置。

`GROKBOT_UPSTREAM_MODE=ai-stream-chat` 是桌面 `AiService/StreamChat` 的
协议诊断模式；它不能处理 Pi 工具定义或工具结果。在这台机器上，该模式已
通过认证到达上游但于 September 22, 2026 收到 `unimplemented`，因此不是
旧 `inference` 的可用替代方案。

`GROKBOT_UPSTREAM_MODE=grokbot-service` 是基于当前桌面 0.30.0
`GrokBotService` 的新文本路径。它要求稳定的 Pi session ID，为每个 Pi 会话
（按登录账号隔离）创建一个独立的新 Bot；映射保存在私有文件中，重启继续使用，
不会自动删除旧 Bot。缺少稳定 ID 的请求会被拒绝，不会退回到旧的共享 Bot。该模式仍在
验证阶段，暂时只支持文字，Pi 工具定义和工具结果会在发送前返回
`upstream_tools_not_supported`，不会被悄悄忽略或发给 Bot。

```sh
node --env-file=.env bin/grokbot2api.mjs
```

`--env-file` 需要 Node >= 20.6；推荐直接使用上述开发测试要求的 Node 版本。
程序不会自动读取 `.env`。也可以由服务管理器注入环境变量，再执行 `npm start`。
`/health` 只说明服务进程可用，不说明上游已鉴权成功。

## 2. 配置 Pi

配置模板：[examples/pi/models.json](../examples/pi/models.json)。
将模板中的 `providers.grokbot` **合并**到 `~/.pi/agent/models.json`，不要覆盖已有 provider。
首次使用且该文件不存在时，可以从项目目录执行：

```sh
mkdir -p ~/.pi/agent
cp -n examples/pi/models.json ~/.pi/agent/models.json
```

核心配置：

```json
{
  "providers": {
    "grokbot": {
      "baseUrl": "http://127.0.0.1:8793/v1",
      "api": "openai-responses",
      "apiKey": "$GROKBOT2API_KEY",
      "models": [
        {
          "id": "grok-4.5",
          "name": "Grok Bot (Responses sidecar)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 256000,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

在运行 Pi 的终端设置 `GROKBOT2API_KEY`，值必须与 sidecar 相同。
模板中的 `$GROKBOT2API_KEY` 是 Pi 0.87.1 的环境变量插值，不是直接发送的字符串。
若你已安装 Pi，先用 `pi --version` 确认版本；旧版本的配置语法可能不同。

- `baseUrl` 以 `/v1` 结尾，**不要**写成 `/v1/responses`。
- 地址是从 **Pi 进程所在机器**访问的。不同机器不要填 `127.0.0.1`；推荐 SSH 隧道或受保护的 HTTPS 反向代理，不要裸露到公网。
- `reasoning: false` 仅关闭 Pi 的 reasoning 参数/思考展示路径，**不代表关闭上游模型推理**。
  `GrokBotService` 发送请求时没有模型选择字段；实际模型由目标 Bot 的配置决定，
  `grok-4.5` 目前只是 Pi/sidecar 暴露的兼容模型名，不能据此断言实际用了 Grok 4.5。
- `input: ["text"]` 是有意限制：这个 sidecar 还没有实现图片转换。
- `contextWindow: 256000` 来自仓库静态目录，不是实时探测；`maxTokens: 8192` 是保守的客户端输出预算，不是已验证的上游最大输出限制。
- 零 `cost` 仅是本地费用显示占位，不意味着账号调用免费、不消耗额度。

## 3. 真实账号验收

在 sidecar 和 Pi 的 Key 都已配置后，先做不执行工具的请求：

```sh
pi --provider grokbot --model grok-4.5 --thinking off --no-tools -p "只回复 OK"
```

### 当前可用的纯文字 skill

Pi 0.87.1 的显式 `/skill:名称` 会把该 `SKILL.md` 的说明展开到用户消息；
当前 `grokbot-service` 能转发这段文字。已用隔离的文本-only skill 分别通过
假上游契约测试和一次真实 Grok Bot 回复验收，不依赖文件或命令工具：

```sh
pi --provider grokbot --model grok-4.5 --thinking off --no-tools --no-extensions
# 在 Pi 内输入：/skill:你的纯文字skill名称 你的问题
```

这只适用于**无需读取文件、执行脚本、调用工具**的 skill。Pi 自动发现 skill
时只把名称、描述和路径放入系统提示；当前新上游仅转发最后一条用户文本，
不会把这些系统提示或完整历史传给 Bot。因此尚不能依赖自动挑选 skill，
也不能把显式 skill 的文字回答当成实际执行了它附带的脚本。

只有使用已验证支持工具的上游模式、且文字验收成功后，才从本项目目录做只读工具验证：

```sh
pi --provider grokbot --model grok-4.5 --thinking off --tools read \
  -p "请使用 read 工具读取 README.md，然后概括这个项目。不要只给我操作建议。"
```

必须看到 **实际 read 工具执行及后续回答**，仅能聊天不能证明 agent 链路可用。
最后进入交互模式：

```sh
pi --provider grokbot --model grok-4.5 --thinking off
```

在可信测试目录里逐步启用 `bash`、`edit`、`write` 等工具；Pi 会在它所在机器执行模型请求的工具。
不要一开始就在重要项目里开放写入/命令执行。

真实环境还应检查：取消生成后马上再次提问、连续多轮工具调用、Token 刷新后的调用、429 冷却后的恢复。
首次调试可在 Pi 的 `settings.json` 合并 `{"retry":{"enabled":false}}`，避免自动重试遮蔽第一个错误。

## 4. 可重复的离线兼容测试

```sh
npm ci
npm run test:pi
npm test
npm run check
```

安装依赖需要网络。安装完后的 Pi 测试使用隔离的临时 HOME / 配置 / 工作目录、
`--offline` 和禁用扩展/技能/项目上下文发现；只允许 `read` 工具。
不加载你的 Pi 账号、不调用真实 Grok Bot、不执行工作区里的命令或扩展。
测试结束清理临时目录。
生产环境仅启动 sidecar 不需要安装 Pi；如需安装生产依赖可用 `npm ci --omit=dev`。

## 仍然存在的边界

- `GROKBOT_UPSTREAM_MODE=ai-stream-chat` 仅支持文字；它会明确返回
  `upstream_tools_not_supported`，不是 Pi 的工具故障或登录故障。
- `GROKBOT_UPSTREAM_MODE=grokbot-service` 目前也仅支持文字，并且要求
  稳定 Pi session ID。它通过 transcript 将文字回复映射回 Responses；Pi
  工具循环要等 Grok Bot 的工具 transcript 协议经单独真实验收后才能启用。
- 单个 sidecar 只允许一个生成请求，多个 Pi 会话同时请求会得到 `429 concurrency_limited`。
- 使用 Pi 完整历史回传方式；不支持服务端 `previous_response_id` 历史恢复。
- 不支持图片、文件输入、内置搜索、自定义 grammar 工具、完整 reasoning 内容或完整 Responses 功能。
- 上游可能还有未覆盖的工具分片形态；真实工具循环必须另做验证。
- `tool_choice` 等部分参数尚未完整实现；不要把这个入口当作通用 OpenAI API 替代品。
- Token 刷新依赖外部提供器；静态模型列表并非账号实时授权列表。
- 默认请求体上限 1 MiB；只有确实遇到 413 时再按 README 调高。

参考：Pi 的 [自定义模型配置文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)。
测试版本固定于 lockfile，避免用滚动更新的文档代替本地验证。
