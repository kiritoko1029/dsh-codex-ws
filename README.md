# dsh-codex-ws

让 DSH 里的 **OpenAI（GPT）模型走 Codex 风格的 Responses WebSocket 传输**（即 Codex CLI `supports_websockets = true` 的 "WS 模式"），而不是 SSE 流式。不注册额外模型渠道：按钮在 `openai` 渠道原地生效，非 OpenAI 模型旁不会出现。

## 它做什么

- **不新增模型渠道**。插件拦截 harness 的 `llm/stream` 水流：传输开关为 websocket / auto 时，`openai` 渠道的请求改走 `<baseURL>/responses` 的 Codex 风格传输；切回 SSE 时原样放行给原有 openai 适配器（模型选择器始终只有一组 OpenAI）。
  - **WS 模式**：`wss://<baseURL>/responses`，发送 `{ "type": "response.create", ... }` 后接收与 SSE 完全相同的 Responses 事件流；连接按池复用（干净结束后保留 3 分钟，50 分钟强制换新）。
  - **SSE 模式**：不拦截，走 DSH 原有 openai 渠道的流式请求（auto 模式下的回退则是普通 `POST /responses` + `stream: true` 打到同一中转站）。
  - 拦截层复刻了适配器边界的投影（文件 → 可读路径句柄、图片 → 文本占位、developer 消息丢弃、deferLoading 工具声明展开），WS 路径目前仅发送文本，不会把图片原始内容发送给模型；不能视为与原生多模态适配器完全等价。
- 接口地址与 Key 的解析顺序（`lib/config.js`）：
  1. 插件配置里的 `baseURL` / `apiKey`
  2. `envFile`（.env）或环境变量 `apiKeyEnv`（默认 `OPENAI_API_KEY`）
  3. **`~/.codex/config.toml`** 中 `supports_websockets = true` 的 `[model_providers.*]`（取其 `base_url` 与 `experimental_bearer_token`）
  4. 内置默认（`https://sub.cxc2.cn/v1`）
- 输入框右侧、模型选择器旁的 **WS / SSE** 小按钮实时切换传输模式（下一次模型请求生效），选择持久化在 `$DSH_HOME/codex-ws/state.json`。**按钮只在该会话当前模型位于 openai 渠道时出现**，其他模型旁不存在。

## 安装

从 [GitHub Releases](https://github.com/kiritoko1029/dsh-codex-ws/releases) 下载 `dsh-codex-ws-1.1.0.tgz`，在 DSH 插件管理中安装本地包；或克隆仓库后从本地目录安装。安装后刷新插件和界面。

## 使用

1. 确认 openai 渠道（llm-pi-ai 的 `openai`）已配置好 Key；模型选择器里选任意 GPT 模型。
2. 模型选择器旁会出现 WS / SSE 按钮：默认即 WS 模式（可配置）；点一下切回 SSE 流式，再点切回 WS。
3. 插件配置（设置 → 插件 → Codex WS → 配置）可改：`transport`（websocket / sse / auto，auto = WS 连接失败自动回退流式）、`baseURL`、`apiKey`、`apiKeyEnv`、`envFile`、超时等。

## 说明

- WS 模式每次请求仍发送完整上下文（`store: false`，带 `prompt_cache_key` 命中中转站缓存），不使用 `previous_response_id` 续传，因此与现有会话/重放完全兼容；WS 的低延迟收益来自连接复用与中转站转发路径。
- Key 只在 Host 侧使用，浏览器端只拿到 `/codex-ws/state` 返回的开关状态与端点地址（不含 Key）。
