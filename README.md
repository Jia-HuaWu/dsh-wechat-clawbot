# dsh-wechat-clawbot

把**微信 ClawBot**（腾讯 iLink 官方 Bot 通道）接进 [DSH](https://github.com/deepseek-ai/deepseek-harness)。

在任意对话里说一句「把这个对话绑定到微信」，扫码后就能在微信里和这个对话聊天：
**手机上看回复，电脑上看完整的思考过程与工具调用。**

不需要安装 OpenClaw。

---

## 这是什么，为什么能这么简单

2026 年腾讯通过 OpenClaw 开放了个人微信的官方 Bot 通道，产品名叫「微信 ClawBot」，
底层协议叫 **iLink**，接入域名 `ilinkai.weixin.qq.com`。

关键点在于：**它只是一条 HTTP/JSON 消息通道，和 OpenClaw 没有技术绑定。**

腾讯官方发布的 `@tencent-weixin/openclaw-weixin` 是一个 OpenClaw 渠道插件，
但拆开看，它做的事情全部是普通 HTTP 调用：

| 能力 | 接口 |
|---|---|
| 拿登录二维码 | `POST /ilink/bot/get_bot_qrcode?bot_type=3` |
| 轮询扫码状态 | `GET  /ilink/bot/get_qrcode_status?qrcode=…` |
| 收消息（长轮询） | `POST /ilink/bot/getupdates` |
| 发消息 | `POST /ilink/bot/sendmessage` |
| 申请上传地址 | `POST /ilink/bot/getuploadurl` |
| 取 typing_ticket | `POST /ilink/bot/getconfig` |
| 「正在输入」 | `POST /ilink/bot/sendtyping` |

所以本插件把这套协议自己实现了一遍（`lib/ilink.mjs`，只依赖 `node:*` 和全局 `fetch`），
再把收到的消息交给 DSH 的 agent，把 agent 的输出发回微信。OpenClaw 完全不在链路里。

> ⚠️ **合规提醒**：这是腾讯官方功能，配套有《微信 ClawBot 功能使用条款》。
> 腾讯明确定位自己是"管道"（不提供 AI 服务、不存内容），并保留随时限流、拦截、
> 终止连接的权利。正常个人使用没问题，但**不要把核心业务完全押在它上面**。

---

## 安装

```powershell
dsh plugin --profile desktop add link:<本插件目录的绝对路径>
```

装完**重启 DSH**（工具注册与监听都在启动时装配）。

> 桌面版的 `desktop` profile 由 Electron 应用独占，只能用 `dsh plugin` 管理插件，
> 不能用命令行启动它。

---

## 用法一：把某个对话绑定到微信（推荐）

在你想绑定的那个对话里说：

> 把这个对话绑定到微信

agent 会调用 `wechat_bind_this_conversation` 工具，返回一个二维码链接。
用手机微信扫码（或直接在手机上打开那个链接）并确认，然后在微信里给这个 bot
发任意一条消息 —— 这个微信就绑定到当前对话了。

此后：

- 微信里发的消息直接进入**这个对话**；
- 手机上看到 agent 的回复（文字 + 图片）；
- 电脑上看到完整过程：思考内容、工具调用、文件操作等。

解除绑定：在同一个对话里说「解除微信绑定」，或调用 `wechat_unbind_this_conversation`。

**一个对话同时只能绑定一个微信。** 想换微信，先解除再重新绑定。

### 为什么能做到「绑定到当前对话」

DSH 的工具执行上下文里带着 `exec.agent.session.id` —— 就是**当前这个对话**的会话 id。
绑定工具把它连同一次性 code 一起写进待领取表；扫码确认后，这个微信的**首条消息**
会认领该 code，从而把绑定关系落到那个会话上。之后的每条消息都路由进同一个会话。

因为消息是作为普通用户消息 `followup()` 进会话的，所以它和你在电脑上打字完全等价 ——
agent 的思考、工具调用、文件改动都照常在电脑上可见。

### 为什么 source.kind 用 `user`

微信发来的消息，`source` 字段写的是：

```js
{ kind: 'user', via: 'dsh-wechat-clawbot', wechatUserId: '...' }
```

这里有个容易踩的细节：DSH 前端**只把 `source.kind === "user"` 的 `user/message`
渲染成正常用户气泡**。其他任何 kind（包括合法的 `plugin:<包名>`）都会被降级成
折叠的「上下文注入」行——你会在电脑上看到一条灰扑扑的系统提示，而不是自己说的话。

同时 session v4 的持久化层又拒绝字面量 `"plugin"`，所以只能在
「`plugin:<包名>`（合法但显示成上下文）」和「`user`（正常气泡）」之间选。
微信消息本质就是用户输入，选 `user`。

---

## 权限：微信端没人能点「同意」，所以自动拒绝

这是微信通道和网页端最大的行为差异。

### 为什么需要处理

DSH 默认策略是 `approval: ask`——需要审批的操作会弹窗等人点。
但在微信里，你根本看不到那个弹窗，于是整个 turn 会**卡死**，直到你在电脑前
手动点同意。

### 插件怎么做

每个微信会话在跑之前，插件都会钉上两个东西：

| 项 | 值 | 作用 |
|---|---|---|
| `sandbox` | `workspace-write` | 工作区内可读写 |
| `approval` | `never` | **需要审批的操作直接拒绝**，不再挂起 |

`approval: never` 是 DSH 原生支持的策略：在 `never` 下 `approval.decide()`
直接返回 `"rejected"`，请求根本不会走到弹窗。

另外还挂了一个 `approval/request` 的 answerer 作为兜底（一律回 `rejected`），
防止某些版本里预设没设上。

### 在微信里改权限

直接发一句话：

```
修改权限为完全权限
修改权限为工作区
修改权限为只读
```

| 说法 | 效果 |
|---|---|
| 完全权限 / 全部 / 不受限 | `danger-full-access`，不限制 |
| 工作区 / 当前目录 | `workspace-write`，工作区外被沙箱挡住 |
| 只读 / 只能读 | `read-only`，不能改文件 |

只发「权限」两个字会列出可选项。选择会被记住，之后每条消息都沿用。

> 注意：无论选哪个预设，`approval` 始终是 `never`。
> 放开范围靠**切沙箱模式**，而不是靠「允许弹窗」——微信里没人能点。

---

## 多条推送与选择性推送

默认行为：agent 这一轮说了什么，就整段发到微信。

但你在电脑上经常需要写一大段（分析、日志、命令输出），而手机上只想看关键几句。
这时让 agent 调用 **`wechat_reply`** 工具：

```js
wechat_reply({ messages: ['好的', '有什么我可以帮你的'] })
```

效果：

- 微信收到**两条独立消息**：「好的」、「有什么我可以帮你的」；
- 你在正文里写的长篇分析**不会**推到微信（电脑上照常可见）；
- 不调用这个工具时，退回默认行为：整段回复作为一条消息发出。

这正好对应你说的用法：电脑端写「我需要回复用户：好的 / 有什么我可以帮你的」，
手机上就只收到那两条。

同一个微信会话里只调用一次即可，多条内容都放进 `messages` 数组。

### 是「立即发送」，不是「排队等这一轮结束」⚠️

这一点很关键，早期实现踩过坑。

`wechat_reply` 会**当场**把消息发到微信（`sendText` 立即执行），
不会等这一轮所有工具都跑完。所以：

```
你：在吗
  ↓
agent 调 wechat_reply(['收到，我先看看'])  →  微信立刻收到 ✅
  ↓
agent 继续思考、连着调十几个工具（可能几分钟）
  ↓
本轮结束 → 不重复发送
```

如果实现成「排队等 turn/end」，你会看到：agent 明明已经想好要说什么了，
手机上却长时间一片空白，然后突然收到一大坨。这就是「收不到简短回复」的原因。

`scripts/verify-immediate-reply.mjs` 专门验证这一点：它记录每条
`sendmessage` 发生在 `turn/end` 之前还是之后，断言必须是**之前**。

> 顺带一个容易犯的错：`waitForReply()` 返回的对象必须**暴露内部 waiter**
> 引用，否则 `waiter.deliver = ...` 会加到一个空的外层对象上，
> 立即发送会静默失效。这个 bug 真的发生过，测试就是那时候抓到的。

---

## 用法二：不绑定，每个联系人一个独立会话

如果不说「绑定这个对话」，插件会按发信人 `from_user_id` 推导出一个稳定会话 id
（`wechat-<16位>…`），每个微信联系人各自一个会话。适合「多人共用一台 DSH」的场景。

---

## 图片

**双向都支持**（这不是微信的限制）。

### 收图片（微信 → DSH）

1. 从 `image_item.media` 拿到 CDN 引用与 AES key；
2. 下载密文，AES-128-ECB 解密；
3. 嗅探真实格式（JPEG/PNG/GIF/WebP）；
4. 交给 DSH 的 attachments 服务落成附件；
5. 作为 `image` 内容块随消息交给 agent。

所以你在微信里发张照片，agent 能直接「看到」它。

### 发图片（DSH → 微信）

如果 agent 调用了生图工具（比如本机的 `ujn_generate_image`），工具返回的
`image` 块会进入会话消息；插件监听到该块后：

1. 从附件存储读出字节；
2. 随机生成 16 字节 AES key，AES-128-ECB 加密；
3. `getuploadurl` 拿预签名地址；
4. POST 密文到 CDN，从响应头 `x-encrypted-param` 取下载参数；
5. 作为 `image_item` 发到微信（配文单独一条）。

**实际效果**：在微信里说「画一只猫」，手机就能直接收到生成的图。

---

## 它是怎么工作的

```
微信用户
   │  发消息
   ▼
腾讯 iLink ──getupdates 长轮询──▶ lib/index.js（监听循环）
                                      │
                                      │ 查绑定表 → 决定目标会话
                                      │ followup(图片块 + 文本)
                                      ▼
                                 DSH agent（绑定的那个对话）
                                      │
                                      │ session/event:
                                      │   assistant/message → 收集文本 + image 块
                                      │   turn/end          → 封口
                                      ▼
                      发回微信：图片先（加密上传 CDN），文字后（回带 context_token）
```

### 三个设计要点

**1. 回复靠事件收集，不靠轮询**

监听 DSH 的 `session/event`：`assistant/message` 累积文本与图片块，`turn/end` 时封口发出。
会话日志本身就是唯一事实来源，不会和应用层抢输出。

**2. 游标必须持久化**

`getupdates` 返回的 `get_updates_buf` 是消息游标。插件把它存在
`$DSH_HOME/dsh-wechat-clawbot/state.json`（权限 0600，因为里面有 `bot_token`），
每次推进都落盘。**丢了这个游标就会重复收消息或漏消息。**

**3. 绑定是「扫码 → 首条消息认领」两段式**

扫码只能确认「谁连进来了」，拿不到「要绑到哪个对话」。
所以绑定工具先写一条带 `sessionId` 的待领取记录，登录确认后把 code 回传给调用方，
首条消息进来时按 code 认领 —— 这样跨重启也不会丢。

---

## 实现细节里几个容易踩的坑

### 工具的 `output.render` 必须返回 `ContentBlock[]`

不是字符串。DSH 的 `ToolDefinition.output.render` 签名是
`render(args, value): ContentBlock[]`，宿主拿到结果后会直接对它做
`content.some(...)`。返回裸字符串会在工具结果写回会话时抛
`content.some is not a function` —— 而且**工具本身已经执行成功了**，
所以现象看起来像"工具失败"，实际是渲染阶段炸的。

所有给人看的文字都要包成 `[{ type: 'text', text }]`。
`scripts/integration.mjs` 里有一条断言专门盯这个形状。

### 扫码确认就立即绑定（不要只靠首条消息认领）

`get_bot_qrcode` 的确认回调能告诉你「谁连进来了」（`ilink_user_id`）。

**现在**：确认时立刻 `bindSession(ilink_user_id, bindSessionId)`，扫码完就能用。

**曾经**：只写一条 `pendingBinds[code]`，等首条消息来了才认领。这套反复失败，
因为 `binded_redirect`、用户不发消息、token 失效都会让认领永不发生 ——
详见下面「绑定：扫码确认就立即绑」一节。

`pendingBinds` 作为兜底保留（服务端没给 `ilink_user_id` 时），且有 TTL
（12 小时），避免几天后随手一条消息串到别的对话上。

这些是从官方插件源码里读出来的、协议文档不会写的细节：

### `X-WECHAT-UIN` 每次都要变

```
随机 uint32 → 十进制字符串 → base64
```

官方用于防重放。写死一个值可能被服务端拒。

### `context_token` 必须原样回带

每条入站消息都带 `context_token`。回复时**必须**把它塞进 `sendmessage` 的
`msg.context_token`，否则消息关联不到正确的会话窗口。

### 消息 ID 是 uint64，会丢精度

`getupdates` 返回的 `message_id` / `svr_id` 是 uint64，超过 `2^53` 时 `JSON.parse`
会静默丢精度。`parseLosslessJson()` 在解析前把这些字段的裸数字改写成字符串 ——
只改对象属性位置，不会误伤字符串内部的同名文本。

### 扫码状态不止 wait / confirmed

`get_qrcode_status` 可能返回 8 种状态：

| 状态 | 含义 | 插件处理 |
|---|---|---|
| `wait` | 等待扫码 | 继续轮询 |
| `scaned` | 已扫码待确认 | 提示用户 |
| `confirmed` | 确认成功 | 存 token，开始监听 |
| `expired` | 二维码过期 | 提示重新发起 |
| `scaned_but_redirect` | IDC 重定向 | 切换轮询 host 继续 |
| `need_verifycode` | 需要配对码 | 让用户填数字 |
| `verify_code_blocked` | 配对码错误过多 | 中止 |
| `binded_redirect` | 该微信已绑定过 | 视为成功 |

`scaned_but_redirect` 尤其容易漏 —— 漏了会在某些网络环境下卡死在「已扫码」。

### 长轮询会退化成紧循环

正常情况下 `getupdates` 被服务端 hold 30 秒以上。但网关异常、被限流、或被中间设备
掐断时，接口可能**立刻**返回空结果。不加节流就会把一个 CPU 核跑满，还会打爆对方接口。

插件里用 `MIN_POLL_INTERVAL_MS = 1000` 兜底。

> 这个 bug 是写集成测试时真实撞到的 —— 假服务器立即返回，整个测试进程被微循环饿死。

### AES key 有两种编码

`CDNMedia.aes_key` 在线上有两种形态，解错了就解不出图：

- `base64(16 字节原始 key)` —— 图片常用
- `base64(key 的 32 字符 hex)` —— 文件/语音/视频常用

`parseAesKey()` 两种都认。另外发图时 `aes_key` 要填 **base64(hex 字符串)**，
而不是 base64(原始 key) —— 官方实现如此，写反了对方解不开。

### 图片消息的 `mid_size` 填密文大小

`image_item.mid_size` 用的是 **AES 加密后**的字节数（`aesEcbPaddedSize`），
不是原图大小。

### CDN 上传的响应头

上传成功与否**不看 body**，只看响应头 `x-encrypted-param`。这个值就是后续
`sendmessage` 里的 `encrypt_query_param`。4xx 应立即失败，5xx 才重试。

### 「正在输入」是可选的

要先 `getconfig` 拿 `typing_ticket`，再拿它去 `sendtyping`。这步失败**不应该**
影响主流程，所以插件里全程 try/catch 忽略。

### 消息 source.kind 不能是字面量 `"plugin"` ⚠️

这是**最阴的一个坑**，因为它不会在写入时报错。

DSH 的 session v4 要求每条消息带「生产者自己拥有」的 source kind：

```
{ kind: "plugin", plugin: "dsh-wechat-clawbot" }   ❌ 会被拒绝
{ kind: "plugin:dsh-wechat-clawbot" }              ✅ 正确
```

**关键**：内存里的 `Session.append()` **不校验**这个字段，所以写入看似完全正常；
校验发生在**读取已持久化事件**时（`assertReleasedV4Relationships`）。结果是：

- 微信消息进来 → 写入成功 → agent 回复发出 → 你看到回复（第一次可能还是好的）
- 但会话日志里留下了非法 source
- **下次读这个会话 / 重启 DSH 时**，整个会话报
  `format v4 message requires a producer-owned source kind`

`plugin:<包名>` 这个写法不是随便编的 —— 它正是 DSH 自己 v3→v4 迁移器的改写规则
（`producerKind()` 对未知插件的返回值）。

`scripts/verify-dsh-contract.mjs` 会**直接调用真实的**
`assertReleasedV4Relationships` 来验证这一点，而不是复刻规则 ——
这样即使将来 DSH 改了契约，测试也能立刻发现。

### 绑定：扫码确认就立即绑，**不要**等首条消息 ⚠️

这条是反复踩坑后改的，值得单独说清楚。

早期设计是两段式：扫码 → 写一条带 `sessionId` 的待领取记录（`pendingBinds`）
→ 该微信发来**首条消息**时才认领，绑定才真正生效。

**为什么这套在实践中反复失败**（现象就是「换了对话、扫了新码、完全没效果」）：

1. 服务端可能返回 `binded_redirect` —— 这个微信以前连过本 DSH，就不再下发
   新 token，也**不给 `ilink_user_id`**。早期代码看到这个分支直接返回
   「无需重复连接」就完事了，本次要绑的目标对话被整个丢弃，`pendingBind`
   永远悬着。
2. 用户扫完不一定会马上发消息，认领就不发生。
3. token 一旦失效（`errcode -14`），消息收不到，认领更不可能发生。

**现在的做法：扫码 `confirmed` 时当场绑定。** 只要服务端在响应里给了
`ilink_user_id`（知道是谁扫的），就直接写绑定表，不等任何消息。

`binded_redirect` 分支也一并修了：它拿不到 `ilink_user_id`，就退回用
**已知的绑定用户**（`runtime.userId` 或现有绑定表里唯一的 key）来完成改绑 ——
总比把这次扫码丢掉好。

`pendingBinds` 的两段式认领**保留**为兜底（服务端确实没给 `ilink_user_id` 时
仍要靠首条消息）。记录有 TTL，过期丢弃。

对应测试：
- `扫码确认后立即绑定（不再依赖首条消息）`
- `binded_redirect 时也会改绑到新对话（不再丢弃）`

### 消息必须带 `id` 和 `role`（否则会话会 corrupt）⚠️

这是**比 source.kind 更凶的坑**，因为它会毁掉整个会话。

DSH 的 session 在**持久化读取期**校验：

```
assertMessageEventShape(event)
user/message 要求：
  message.id      非空字符串
  message.role    === "user"
  message.source.kind 非空且不是 "plugin"
  message.content 是数组
```

关键在于「读取期」三个字：**内存里 `Session.append()` 不检查这些字段**。
所以历史上出现过：

1. 微信消息进来，`followup({ content, source })` —— 没有 `id`、没有 `role`
2. 内存写入成功，消息也正常发回微信 ✅
3. 但日志里留下了坏事件
4. **下次读这个会话 / 重启 DSH** →
   `session event at seq N lacks an identified message`
   → 整个会话判为 corrupt，历史加载失败 ❌

官方用 `@deepseek-ai/dsh-llm` 的 `createUserMessage()` 保证这些字段。
第三方插件解析不到那个包（不在 profile 的 node_modules 里），所以插件里
复刻了同样的规则：

```js
function createUserMessage(input) {
  return {
    id: randomUUID(),      // ← 必须
    role: 'user',          // ← 必须
    content: input.content,
    source: input.source,
  }
}
```

`scripts/verify-message-shape.mjs` 会加载**真实的 dsh-session**，把缺字段的
消息走一遍完整往返（append → 序列化 → 重新加载），确认它确实被拒；
同时确认插件实际构造的消息能通过。

### 会话损坏时不要 create 同名会话

`ctx.agents.resume()` 失败有两种完全不同的原因：

| 原因 | 正确处理 |
|---|---|
| 没有历史（新会话） | `create()` 一个 |
| **有历史但损坏** | **不能** `create()` —— 同名会话仍存在，会报 `session "..." already exists` |

早期实现把两者混为一谈，于是用户在微信里看到的就是那句莫名其妙的
`session "..." already exists`。现在按错误措辞区分，损坏时如实告诉用户
「日志已损坏」并建议修或换一个对话。

### 绑定的会话可能已经不存在了 ⚠️

这是「换个对话扫码却没效果」的**另一半原因**，也是最能骗人的一个。

场景：你在 DSH 里删掉（或归档）了被绑定的对话。日志目录没了，但插件的
`state.json` 里还留着那个 `sessionId`。于是：

- 每条微信消息都往一个**幽灵会话**里发；
- 电脑上看不到任何东西（会话不存在），微信也没回复；
- 你换个对话重新扫码 —— 但**旧绑定还在**，而且 `binded_redirect` 分支
  又把这次扫码当「无需重复连接」丢弃了，所以怎么扫都没用。

现在的处理：

1. **入站时校验会话是否还存在**（live agent 或磁盘日志），不存在就清掉绑定、
   退回独立会话，保证消息至少能进一个真实会话；
2. 清掉绑定时**写墓碑**（`bindingTombstones[id] = 时间戳`），否则
   `persist()` 的合并逻辑会按 `boundAt` 把磁盘上的旧记录又合并回来 ——
   表现为「删不掉」。

> 这个墓碑机制是必需的：`mergeNewerBindings()` 按时间戳取较新的一份，
> 而 `delete` 操作没有时间戳。没有墓碑，删除永远输给磁盘上那条旧记录。

### 自查：`scripts/doctor.mjs`

出问题先跑这个，它一次性检查：

```powershell
node scripts/doctor.mjs
```

输出覆盖：登录状态、token 是否还有效（直接问服务端）、绑定指向的会话
是否还存在、会话日志有没有坏消息、有没有悬着的待领取绑定、是否落在
「未分组」。最后给出可直接执行的修复建议。

---

## 文件结构

```
dsh-wechat-clawbot/
├── lib/
│   ├── ilink.mjs       iLink 协议实现（登录、长轮询、收发、媒体加解密、CDN）
│   └── index.js        DSH 插件：绑定、监听、agent 路由、设置页路由、工具
├── scripts/
│   ├── selftest.mjs           协议层自检（默认离线，--live 打真实接口）
│   ├── integration.mjs        插件主流程集成测试（假 ctx + 假服务端）
│   └── verify-dsh-contract.mjs 用真实 DSH 依赖验证插件遵守其契约
├── cordis.patch.yml    把插件插入 profile 配置树
└── package.json
```

## 工具

| 工具 | 作用 |
|---|---|
| `wechat_bind_this_conversation` | 把当前对话绑定到微信，返回二维码 |
| `wechat_unbind_this_conversation` | 解除当前对话的绑定 |
| `wechat_reply` | **声明这一轮推什么**（支持多条、可只推部分） |
| `wechat_send_message` | 主动给某个微信用户推送文本 |
| `wechat_list_contacts` | 列出已知微信联系人及其绑定关系 |

## 测试

```powershell
cd <本插件目录>
npm test                             # 跑下面全部三项
node scripts/selftest.mjs            # 21 项离线检查
node scripts/selftest.mjs --live     # 额外验证真实 iLink 接口
node scripts/integration.mjs         # 35 项主流程集成测试
node scripts/verify-multi-push.mjs   # 干净环境端到端验证多条/选择性推送
node scripts/verify-dsh-contract.mjs # 5 项 DSH 契约验证
```

四层测试各有分工：

- **selftest** 测协议编解码、AES、CDN 上传组装——不依赖 DSH。
- **integration** 用假 ctx 跑通主流程：扫码登录状态机、消息往返、游标持久化、
  会话复用、工具契约、绑定到当前对话、重新绑定覆盖、图片双向收发、安全护栏、
  重启恢复、首条消息认领、权限自动拒绝与切换。
- **verify-multi-push** 在**全新实例**里端到端验证「agent 声明两条 →
  微信收到恰好两条，正文不外泄」。单独一个脚本是因为 `integration.mjs` 会累计
  几十个实例抢同一个消息队列，端到端时序不可控。
- **verify-dsh-contract** 加载**真实** DSH 包，验证插件对它的假设成立。
  这是唯一能抓住「只在真实运行时暴露」问题的层——
  比如 `source.kind` 那个坑，前两层都测不出来。

> `integration.mjs` 里的假 agent 会**复刻** DSH 的 source 校验规则，
> 所以拿字面量 `"plugin"` 时会像真实环境一样抛错。这是刻意的：
> 否则这个 bug 会再次漏网。

## 安全

- **状态文件 0600**，里面是 `bot_token`。
- **设置页路由 fail-closed**：只认同机回环地址，拒绝 `sec-fetch-site: cross-site`，
  `Origin` 与 `Host` 不一致一律 403。这些路由能写 token，不能对任意来源开放。
- 需要从别的 host 访问时，设 `DSH_WECHAT_CLAWBOT_TRUSTED_HOSTS`（逗号分隔）。
- **`approval` 恒为 `never`**：微信通道永远不会把需要审批的操作挂起等人。

## 当前限制

- **24 小时窗口**：微信 ClawBot 只接收 **24 小时内**的回复。这是微信侧的产品限制。
- **不支持群聊**：官方插件的元数据也只声明支持私信。
- **没有历史消息拉取接口**：只有 `get_updates_buf` 游标，离线期间的消息拿不到。
- **语音不做转码**：微信侧如果给了语音转文字就用，没给就只标注「[语音]」。
  要完整支持需要 SILK 解码（官方用 `silk-wasm`）。
- **视频/文件出站未实现**：协议支持，但当前只做出站图片。
- **权限不能在微信里「点同意」**：只能切沙箱范围（只读/工作区/完全）。
  真要逐次审批，得回电脑上操作。
- **`wechat_reply` 只在微信触发的那一轮有效**：它给的是「这一轮推什么」。
  主动推送请用 `wechat_send_message`。

## 许可

MIT
