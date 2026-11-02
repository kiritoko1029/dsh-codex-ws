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

从 [GitHub Releases](https://github.com/kiritoko1029/dsh-codex-ws/releases) 下载 `dsh-codex-ws-1.2.0.tgz`，在 DSH 插件管理中安装本地包；或克隆仓库后从本地目录安装。安装后刷新插件和界面。

## 使用

1. 确认 openai 渠道（llm-pi-ai 的 `openai`）已配置好 Key；模型选择器里选任意 GPT 模型。
2. 模型选择器旁会出现 WS / SSE 按钮：默认即 WS 模式（可配置）；点一下切回 SSE 流式，再点切回 WS。
3. 插件配置（设置 → 插件 → Codex WS → 配置）可改：`transport`（websocket / sse / auto，auto = WS 连接失败自动回退流式）、`baseURL`、`apiKey`、`apiKeyEnv`、`envFile`、超时等。

## 说明

- **v1.2.0 增量 WS**：首次全量发送；同一会话、同一连接上，只有当前历史严格延续上次输入与已完成输出，且 instructions / tools / model 等请求配置未变时，才使用 `previous_response_id` 并只发送新增 input。仍保持 `store: false`。
- 连接按完整凭据哈希、端点、会话隔离；并发调用独占连接，不共享正在执行的续传状态。空闲 3 分钟或连接总寿命 50 分钟后关闭，全局最多保留 32 个空闲连接。
- 历史压缩、编辑、分支、模型或提示/工具配置变化、连接丢失时自动使用全量。明确收到上一响应不存在错误、且还没有输出时，只允许一次新连接全量重试；已发送后遇到普通网络错误不会盲目重发。取消、未完成、失败结果不保存续传状态。
- 工具 schema 和 instructions 仍随每次请求发送；优化减少历史 input 上传量，不减少模型实际上下文长度，也不保证同等比例的计费下降。DSH 若每一步改写早期历史或系统提示，会触发保守全量发送。
- 验证：`node test/continuation.mjs` 为离线边界测试；`bun test/continuation-live.mjs` 使用合成消息验证中转站续传与实际发送字节（会产生少量 API 调用）。一次实测为 14,242 → 511 字节，第二轮正确回忆第一轮标记；真实降幅取决于历史与固定请求配置大小。
- Key 只在 Host 侧使用，浏览器端只拿到 `/codex-ws/state` 返回的开关状态与端点地址（不含 Key）。
