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
