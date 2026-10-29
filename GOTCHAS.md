# 踩坑实录（Gotchas）

> 从 README 抽出来的完整踩坑记录。这些坑全部在真实运行中撞到过，
> 每一条都有对应的代码修复或测试守着。协议文档不会写这些 —— 撞过才知道。

## 协议与 DSH 契约

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

## 运行时踩到的坑（持续补充）

### 登录状态机不会自己走，必须有人轮询 ⚠️

`wechat_bind_this_conversation` 返回二维码后**没有任何东西在自动推进登录状态机**：
`pollLogin()` 只在设置页路由（`/login/status`）被调用时才走一步。
通过对话工具发起的绑定，工具返回后没人轮询 —— 用户扫码确认了，
DSH 这边也拿不到 `bot_token`，`monitoring` 永远不启动。

**现象**：手机上显示「暂无法连接 openclaw」，DSH 侧 `loggedIn: false`、
状态文件里 `token` 为空，但 `pendingBinds` 里躺着你那次扫码的记录。

**修复**（两种任选）：
1. 绑定后手动推一次状态机：向 `POST /dsh-wechat-clawbot/login/status` 发空请求，
   脚本化的话每 2 秒一次直到 `status: confirmed`；
2. 让绑定工具在返回二维码后自己起一个短轮询循环（内测版可以补上）。

顺带：二维码有效期只有约 2.5 分钟，登录记录 5 分钟后被判过期 —— 扫码要快。

### sessionAlive 会把「正在写日志的活跃会话」误判成幽灵 ⚠️

`handleInbound()` 入场时用 `sessionAlive()` 校验绑定的会话是否还存在：
live agent 找不到就翻磁盘上的 `session.v4.jsonl.zstd`。

问题在于：**活跃会话正在被 DSH 持续写入**，日志处于压缩/轮换的瞬间时
磁盘探测可能失败 —— 于是活跃的绑定会话被判成「已被删除」，
`unbindSession()` 写下墓碑、消息兜底进独立会话。

**现象**：绑定突然消失（`bindings: {}` + 一条新鲜墓碑）、微信消息「被吃掉」
（其实进了 `wechat-xxxx` 兜底会话，电脑上看不到）、绑定表里
`boundAt` 和墓碑时间戳只差 1ms。

**修复**：绑定没了不要慌，直接调 `POST /dsh-wechat-clawbot/bind`
带 `sessionId` + `userId`（不传 userId 时它只改绑「已有绑定」，绑定表空了会 404）。
根治需要给 `sessionAlive` 加宽限重试 —— 待修。

**定位工具**：会话日志是 zstd 多帧流，Python 一行即可解：
`zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data)).read()`
（注意：内容大小不在帧头里，`decompress()` 会抛
`could not determine content size in frame header`，要用 stream_reader。）

---

## 主动待机（A 类消息）的设计取舍

「让 AI 自己决定什么时候开口」听着简单，但有三个坑必须提前想清楚，
否则会变成骚扰用户的刷屏机器。

### 1. 不调工具就不该有下一轮

最自然的实现是「到点触发一次，触发完再自动排下一次」——这是个陷阱：
AI 如果这轮没话说，就会陷入「被叫醒 → 无话可说 → 又被叫醒」的空转，
消耗 token 还刷屏。

现在的做法：**待机是 AI 每轮自己续订的**。`wechat_idle` 只登记一次，
被叫醒后如果 AI 不再调用，链条就自然终止。
`maxChain`（默认 12）是第二道闸：连续触发这么多次都没等到用户真人消息，
直接停掉并在日志里说明原因。

### 2. 「用户说话即取消」比任何取消指令都可靠

用户说「等下别喊我」时，AI 可能理解错、可能忘了调取消工具。
但有一件事永远不会错：**用户发了真实消息**。

所以取消逻辑挂在入站路径上——`handleInbound` 一进来就检查
`idleState.idle.userId === fromUserId`，命中就 `disarmIdle()`。
用户开口 = 他不想被叫，这个推断比让 AI 自己判断靠谱得多。

### 3. A 类消息必须和真人消息可区分

插件模拟用户发的提醒如果和真人消息长得一模一样，事后排查时分不清
「这句话到底是谁说的」，会话日志会变成一笔糊涂账。

做法：`source.via` 写成 `dsh-wechat-clawbot-idle`（定时任务则是
`-schedule`），`source.kind` 仍是 `user`（这样前端照常渲染成用户气泡，
且满足 session v4 的 producer-owned 要求）。想统计「AI 主动说了几次话」
时按 `via` 过滤即可。

### 4. 待机是提醒，不是发言命令（真实踩过的坑）

第一版实现里，被叫醒那一轮的**正文被无条件发到微信**——
因为 agent 对注入消息总会「礼貌回应」点什么，结果变成：
每 5 分钟必来一句，用户明确反馈「待机结束后好像一定会发消息」。

这不是模型的问题，是插件把「提醒」当成了「命令发言」。
修法分三层：

- **沉默是默认路径**：只有 agent 显式调 `wechat_reply` / `wechat_send_image` /
  `wechat_send_message`（有 outbox）才发送；它不调，这一轮微信上零消息，
  正文只留在电脑端会话里。判断依据是 `reply.usedOutbox`。
- **A 类消息正文自带说明**：注入的提醒末尾附一句「你不需要回复这条提醒：
  没什么想说的就什么都不做」。模型在**决策现场**看到这句话，比只写在
  工具描述里（决策可能在几轮之前）有效得多。
- **静默熔断**：就算有自动兜底，AI 连续 N 次被叫醒都沉默（默认 2 次），
  说明它真不想聊，暂停兜底——否则每 N 分钟白叫醒一次，烧 token 还写
  无意义的会话记录。AI 自己调 `wechat_idle`、用户发新消息、保存设置
  都会解除暂停。

一个排障细节：集成测试里 `server.sentTexts()` 是**全局累积**的，
几十个用例跑下来早就发过无数「回声：xxx」，直接断言「没发过回声」必然翻车。
必须以「登记待机之后」为基线取窗口断言——否则修好的功能看起来还是坏的。

### 4. 待机状态和登录状态分开存

`state.json` 里有 `bot_token`（0600）。待机设置改动频繁（每次心跳都读写），
混在一起会导致**每次心跳都重写一份含密钥的文件**——既浪费又有风险面。
所以待机状态单独落在 `idle.json`，`state.json` 只在需要时动。

### 5. 到点时用户正在说话怎么办

定时任务（用户明确要求的「10 分钟后叫我」）到点时，如果该用户有等待中的回合
（`runtime.waiters.has(sessionId)`），不硬插进去打断，而是把 `dueAt` 推后
1 分钟重排。待机心跳则直接作废（用户正在聊，不需要被叫）。

### 6. 设置页要进 DSH 自带面板，而不是自己做一个页面

自建 HTML 页（`/page` 路由）能用，但用户得记一个 URL，等于没进设置体系。
正确做法是走 `dsh.client` 声明的浏览器半边 + `settings.section` 槽位：

- `package.json` 里加 `dsh.client: { platform: 'web', inject: [...] }`；
- **同时**在 `exports` 里加 `"./client": { "default": "./lib/client.js" }`；
- `lib/client.js` 用 `window.__ModuleLoader__.load({ id: <包名>, factory })` 包装，
  通过 `ctx.slots.inject('settings.section', ...)` 注册页面；
- `order` 决定排序——本项目用 `43`，紧跟在同机 `dsh-ujn-image` 的 `42` 之后。

漏掉第二条会是**整机启动失败**，不是这个页面的小毛病：`dsh-client-modules`
在 `resolveMeta` 阶段发现「声明了 `dsh.client` 却解析不出 `./client`」，
抛 `ClientPackageCompositionError`，而 `modules` 是 required 插件，于是
`startup failed: 1 required plugin did not activate`，桌面端直接弹
「The application could not start or stopped unexpectedly」。文件在磁盘上
存在也没用——宿主只认 `exports` 映射，不接受裸路径。同类插件
（`dsh-ujn-image`、`dsh-hidden-sessions`）都同时有这两处，可作模板比对。

一个容易踩的细节：`h()` 不能直接等于 `jsxRuntime.jsx`。`jsx` 的签名是
`(type, config, maybeKey)`，第三个参数会被当成 React 的 **key** 吞掉，
于是子节点整棵丢失、每个元素都只剩 props。必须显式包一层把 children 收进
`props.children`。

---

## `sendMessage ret=-2 errmsg=prepare failed` 是什么

这是**最容易被误解的一个错误**：看着像参数错误或 context_token 失效，
实际是 **iLink 网关对 bot 的突发限流（burst throttle）**。

### 排查过程（值得记下来，因为结论反直觉）

现象：真人发消息时回复一切正常，但**待机/定时任务触发的主动推送全部失败**。

逐项探测的结果：

| 探测 | 结果 |
|---|---|
| `notifyStart` | `ret: 0` ✅ |
| `getConfig`（能拿到 typing_ticket） | `ret: 0` ✅ → 用户会话存在 |
| `getUpdates` 长轮询 | 正常挂起 ✅ |
| `sendmessage`（**不带** context_token） | ❌ `ret=-2 prepare failed` |
| `sendmessage`（带 6 分钟前的 context_token） | ❌ 同样失败 |
| `sendmessage`（带 35 分钟前的 context_token） | ❌ 同样失败 |

**带不带 context_token 结果完全一样** → 排除 token 问题。
同一时刻 `getConfig` / `getUpdates` 都正常 → 排除登录态和网络。

对照第三方实现（[cc-connect 的 weixin 适配器](https://ghproxy.net/https:/raw.githubusercontent.com/chenhg5/cc-connect/main/platform/weixin/weixin.go)）
的源码注释，才拿到权威解释：

> 网关在短窗口内发约 5~6 条独立消息后就会限流该 bot，
> **并且处罚期内每一次发送尝试都会加重处罚**。

### 为什么只有「主动推送」中招

回复路径（真人消息触发的 `wechat_reply`）也会调用同一个 `sendmessage`，
但它**成功**。区别在于：网关在交互式会话里不限制对用户消息的回复，
限制的是「没有新入站消息时的主动发送」。所以表现成
「真人聊天一切正常，待机一响就 prepare failed」。

### 加重处罚是真的

实测日志：首次失败后 agent 连续重试了 3 次（14:31:09 / 14:31:27 / 14:32:02），
12 次失败分散在 44 分钟里、每次都是连续 2~3 发。重试没有让它更快恢复，
反而把惩罚窗口一直拖着——这和源码注释的判断一致。

### 现在的处理

- `sendMessage` 对 `ret=-2` 打上 `error.throttled` 标记，**只抛一次不重试**；
- 主动推送前过 `checkPushBudget()` 闸：滑动窗口配额（默认 4 条 / 60 分钟）；
- 一旦真的命中 `-2`，`notePushThrottled()` 进入 **15 分钟熔断**，期间所有主动推送
  本地直接拒绝（不打接口），避免加重处罚；
- 回复路径不受配额限制（否则正常聊天会被卡死）；
- 设置页可看配额用量 / 限流命中次数 / 熔断剩余时间，并有「解除限流熔断」按钮。

### 真被限了怎么办

只能等。缓解手段按优先级：

1. **停止一切主动推送**（关待机、清定时任务）——持续发送会延长惩罚；
2. 正常和 bot 聊天（回复路径不受限），保持会话活跃；
3. 等窗口滑过（实测可能远超 15 分钟，按小时计）；
4. 实在等不及：重新扫码登录换一个新 bot 会话（`accountId` 会变）。

