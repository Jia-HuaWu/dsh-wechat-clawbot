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

### 主动推送（不需要对方先发消息）

- `wechat_send_message`：传 `messages` 数组一次推多条（每条独立气泡），也兼容单个 `text`。
- `wechat_send_image`：传本地图片的绝对路径（`imagePath`），可选 `caption` 配文。

两者的 context_token 由插件自动回带（记录最近 24 小时内发过消息的联系人），
消息会落回原来的聊天窗口，不会掉到新会话。微信侧只接收 24 小时内的回复，
超出窗口的联系人推送会被拒。

## 引用消息

用户在微信里长按某条消息选择「引用」再输入问题时，引用内容在协议里挂在
`item.ref_item.ref_msg` 上。插件会把它展开成前缀交给 agent：

```
[引用] 报价单A：单价 12 元
这个多少钱
```

这样 agent 就不必靠猜「这个」指的是什么。三种情况分别处理：

| 情况 | 输出 |
|---|---|
| `ref_msg.message_item` 有原文 | 渲染原文（图片/语音/文件也各按其占位标签） |
| 只有 `ref_msg.title` 摘要 | 用摘要 |
| 两者都缺（新版客户端只给 `svr_id`） | `[引用了一条未缓存的消息 #<svr_id>]`，显式标注不静默丢 |

只选中原消息一段时（`ref_msg.partial_text`），会按 `startindex`/`endindex`
截取，并用 `quotemd5` 校验；校验不过就退回全文 —— 宁可多给上下文，不给错片段。

### 设置页

**DSH 自带设置面板里就有**（「设置 → 微信 ClawBot」，排在「济大词元文生图」下面一格），
可以调待机开关、默认分钟数、提醒文案、连续跳数上限，并随时取消当前待机与查看定时任务。

另有独立状态页 `http://127.0.0.1:19387/dsh-wechat-clawbot/page` 可以看到：

- **绑定的对话**：哪个对话绑定了哪个微信用户（对话显示 DSH 侧边栏里的名称，
  其次是绑定备注，最后退回会话 id）；绑定时间；会话是否在线；
- 独立模式下的未绑定联系人会话；
- 收发消息与图片的统计、最近错误。

页面每 5 秒自动刷新；只认同机回环访问（安全护栏与 token 路由一致）。

---

## 主动待机：让 AI 自己决定什么时候找你

默认情况下 agent 只在你说话时才有机会回复。开了主动待机之后，它可以在回复完
**自己定一个闹钟**：N 分钟后如果没人理它，插件会模拟你发一条提醒（A 类消息），
由它决定要不要主动开口。

### 机制

```
你发消息 → AI 回复 → （可选）AI 调 wechat_idle 定 N 分钟
                              ↓ N 分钟后你没动静
                    插件模拟你发一条 A 类消息
                    「过去 N 分钟了，没有任何消息」
                              ↓
                AI 决定：什么都不说（默认）/ 主动说话
                              ↓
                沉默 → 微信零消息，正文只留在电脑端
                说话 → 用 wechat_reply 等发出
                              ↓
                想继续等就再调一次 wechat_idle；
                不调就自然停止，不会缠人
```

四个关键设计：

1. **不调工具 = 停止**。待机是 AI 每轮自己续订的，没有「自动重来」的默认行为。
2. **你说话即取消**。只要发来真实消息，待机立刻作废——所以「等下别喊我」不需要
   任何特殊指令，你不理它它就自然停下（还有 `maxChain` 熔断兜底）。
3. **被叫醒 ≠ 必须发言**。AI 不调发送工具，微信上就什么都没有——待机只是提醒，
   开口与否是它自己的决定（详见下文「待机只是提醒」）。
4. **A 类消息有标记**。`source.via` 会写成 `dsh-wechat-clawbot-idle`，
   电脑上能看出这条「用户消息」其实是插件代发的。

### 定时任务（用户明确要求的时间点）

AI 也可以替你登记一次性提醒：「10 分钟后叫我」→ `wechat_schedule`。
这类任务**不受**待机开关影响（它是你的明确指令），到点时如果你正在对话中，
会自动延后 1 分钟不打断。

### 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 启用主动待机 | 开 | 关掉后 AI 的待机请求全部不生效（存量定时任务仍执行） |
| 默认待机时长 | 5 分钟 | AI 没指定分钟数时用它（1 ~ 1440） |
| 提醒文案 | `过去 {minutes} 分钟了，没有任何消息` | `{minutes}` 会替换成实际分钟数 |
| 最大连续跳数 | 12 | 连续这么多次没得到你回应就自动停（0 = 不限制），防止 AI 自问自答刷屏 |
| 自动待机 | 开 | AI 没主动定时也兜底登记一次；关掉则完全由 AI 自己决定 |
| 静默熔断 | 2 次 | 连续这么多次「被叫醒但 AI 什么都没说」就暂停自动兜底（0 = 不限制） |

设置落在 `$DSH_HOME/dsh-wechat-clawbot/idle.json`，与 `state.json`（含 token，0600）
分开存：待机偏好变化频繁，混在一起会让每次心跳都重写一份敏感文件。

### 待机只是提醒，不是命令发言（重要）

被叫醒那一轮，**AI 的正文不会自动发到微信**。它有三种选择，插件都支持：

1. **保持沉默**（推荐路径）：什么都不调 → 这一轮微信上没有任何消息，
   正文只留在电脑端会话里；
2. **主动说话**：调 `wechat_reply` / `wechat_send_image` / `wechat_send_message` → 照常发出；
3. **继续等**：再调 `wechat_idle` 续订下一轮。

A 类消息的正文里也写明了「你不需要回复这条提醒」。配套的静默熔断：
如果 AI 连续 N 次（默认 2）被叫醒都保持沉默，自动兜底会暂停——
它可能真的不想聊，别硬叫。它自己调 `wechat_idle`、你发新消息、
或保存设置都会解除暂停。

设置页还有「立刻触发一次」按钮和运行诊断（AI 主动调用 / 自动兜底 /
实际触发 / 静默链各多少次），方便不用等 5 分钟就能验证整条链路。

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

## 实现细节与踩坑实录

这个项目在真实运行里撞过不少坑 —— 协议文档不会写的细节、DSH 契约的隐含约束、
时序竞态…… 全部整理在 **[GOTCHAS.md](./GOTCHAS.md)** 里，包括：

- iLink 协议层的暗坑：`X-WECHAT-UIN` 防重放、`context_token` 回带、
  uint64 精度、AES key 的两种编码、CDN 上传只看响应头……
- DSH 契约的隐含约束：`source.kind` 不能写字面量 `"plugin"`、消息必须带
  `id`/`role`（否则会话 corrupt）、会话损坏时不能 create 同名会话……
- 绑定时序：扫码确认立即绑定、`binded_redirect` 不再丢弃、幽灵会话与墓碑机制……
- 运维出口：`scripts/doctor.mjs` 体检、`/bind` 接口改绑、日志损坏修复脚本。

写插件、尤其是给 DSH 写带状态通道的插件的话，值得先看一遍。

想让微信那头的 agent **像真人一样聊天**（多段短消息、颜文字、表情包、
不说 AI 味的客套话）？拿 **[PROMPT-ROLEPLAY.md](./PROMPT-ROLEPLAY.md)**
里的模板填上角色设定直接用。

---

## 文件结构

```
dsh-wechat-clawbot/
├── lib/
│   ├── ilink.mjs       iLink 协议实现（登录、长轮询、收发、媒体加解密、CDN）
│   ├── idle.mjs        待机设置 / 定时任务存储与收敛
│   ├── index.js        DSH 插件：绑定、监听、agent 路由、待机调度、工具
│   └── client.js       浏览器半边：注册 DSH 设置面板里的「微信 ClawBot」页面
├── scripts/
│   ├── selftest.mjs           协议层自检（默认离线，--live 打真实接口）
│   ├── integration.mjs        插件主流程集成测试（假 ctx + 假服务端）
│   └── verify-dsh-contract.mjs 用真实 DSH 依赖验证插件遵守其契约
├── GOTCHAS.md           完整踩坑实录（从本 README 链接过去）
├── PROMPT-ROLEPLAY.md   微信真人感角色扮演提示词模板
├── cordis.patch.yml    把插件插入 profile 配置树
└── package.json
```

## 工具

| 工具 | 作用 |
|---|---|
| `wechat_bind_this_conversation` | 把当前对话绑定到微信，返回二维码 |
| `wechat_unbind_this_conversation` | 解除当前对话的绑定 |
| `wechat_reply` | **声明这一轮推什么**（支持多条、可只推部分） |
| `wechat_idle` | **定待机心跳**：N 分钟后如果没人理，插件发 A 类消息叫醒自己 |
| `wechat_schedule` | 登记定时任务（「10 分钟后叫我」），到点发 A 类消息 |
| `wechat_send_message` | 主动给某个微信用户推送文本（支持 messages 多条连发） |
| `wechat_send_image` | 主动推送一张本地图片（表情包 / 生成的图） |
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
