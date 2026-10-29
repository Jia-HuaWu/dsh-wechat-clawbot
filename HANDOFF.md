# dsh-wechat-clawbot 交接文档

> 写给下一个接手这个插件的 AI（或未来的自己）。仓库在 GitHub 公开：
> `Jia-HuaWu/dsh-wechat-clawbot`；本地工作区 `E:\DeepseekHarness\WechatAgent\dsh-wechat-clawbot`。
> 协议级踩坑在 `GOTCHAS.md`（先读它，本文不重复），本文记录的是**本对话内做过的事、
> 验证状态、以及还没收尾的活**。

---

## 一、当前状态快照（截至本对话结束）

| 项 | 状态 |
|---|---|
| 已发布到 GitHub | `33827e0`（主动待机功能）✅ |
| **本地未提交改动** | ⚠️ 6 个文件修改 + 3 个新脚本，**未 commit/push** |
| 测试 | 21 项自检 + 63 项集成，全部通过（退出码 0） |
| 运行中的 DSH | 加载的是**本地部署副本**，不是 GitHub 上的旧版 |
| 微信绑定 | `o9cq803…@im.wechat` → `session-de10efcc…`（live） |
| iLink 限流 | 当天曾触发（ret=-2），停发主动推送后自愈；有 15 分钟熔断保护 |

### 未提交的改动是什么

这是「限流防护 + 设置页增强」一批工作，功能已完成、测试已过，只差 commit：

1. **`ret=-2 prepare failed` 防护**（根因见 GOTCHAS「sendMessage ret=-2」一节）：
   - `lib/ilink.mjs`：`sendMessage` 对 `ret=-2` 打 `error.throttled` 标记，只抛不重试；
   - `lib/index.js`：主动推送前过 `checkPushBudget()`（滑动窗口配额，默认 4 条/60 分钟）；
     命中 `-2` 后 `notePushThrottled()` 进入 15 分钟熔断，期间主动推送本地直接拒绝；
   - 回复路径（真人消息触发的 `wechat_reply`）不受配额限制；
   - 新路由 `POST /push/reset` 手动解除熔断。
2. **设置页扩展**（`lib/client.js`）：主动推送配额/窗口配置、限流状态显示、「解除限流熔断」按钮。
3. **`idle.mjs`**：新增 `pushLimit` / `pushWindowMinutes` 设置项。
4. **`scripts/integration.mjs`**：+2 个限流测试（配额拦截、熔断与解除）。
5. **新维护脚本**（大肥鱼在微信会话里自己写的，未入库）：
   - `_probe-send.mjs` — 诊断 -2 限流四连探测（notifyStart → 无 ctx → 存储 ctx → getConfig）
   - `_push-text.mjs` — 绕过 LLM 直发文本（学校 API 挂了时的应急通道）
   - `_push-file.mjs` — 推送文件（图片之外的类型）

**收尾动作**：`git add -A && git commit && git push`。建议 commit message：
`主动推送限流防护：配额闸 + 熔断 + 设置页展示；附三个运维脚本`。

---

## 二、本对话完成的全部功能（按用户需求序）

### 1. 基础通道（前期会话）
- 扫码绑定、登录状态机手动推进（`POST /login/status` 轮询——状态机不会自己走）
- `/bind` 改绑接口（不用重扫，兼容 expired 二维码场景）
- 图片双向、`wechat_send_image` 主动推图、`wechat_send_message` 多条连发
- context_token 自动回带（24h TTL）
- `/page` 状态页（绑定关系可视化）

### 2. 主动待机（本对话核心）
- **`wechat_idle`**：AI 自己定待机闹钟；被叫醒后**发不发由 AI 决定**——
  不调发送工具微信上零消息（以 `reply.usedOutbox` 为准），正文只留在电脑端
- **`wechat_schedule`**：用户明确要求的一次性提醒（「10 分钟后叫我」），
  不受待机开关影响；到点遇忙自动延后 1 分钟
- **A 类消息**：`source.via` 标 `-idle` / `-schedule` 后缀，与真人消息可区分
- **自动待机兜底**（`autoArm`，默认开）：AI 没主动定时也按默认时长兜底一次
- **静默熔断**（`silentLimit`，默认 2）：连续被叫醒都不说话就暂停兜底
- **maxChain**（默认 12）：心跳链防自问自答循环
- **`/idle/trigger`**：立即触发一次（免等 5 分钟验证链路）
- 设置页：待机开关、默认分钟数、提醒文案、各项熔断阈值、当前状态、诊断计数

### 3. DSH 设置面板集成
- `package.json` 的 `dsh.client` + `exports["./client"]` **两处缺一不可**
  （漏 exports 会让整个桌面端启动失败，详见 GOTCHAS 第 6 节）
- `lib/client.js` 手写 React（无构建步骤），`settings.section` 槽位，`order: 43`
  排在「济大词元文生图」下面

### 4. 文档
- `GOTCHAS.md`：全部协议级踩坑（uint64 精度、source.kind、墓碑机制、-2 限流、
  settings 集成等）
- `PROMPT-ROLEPLAY.md`：微信真人感角色扮演提示词模板（平台无关）
- `.memory/`：**大肥鱼角色自己的记忆**（不属于插件仓库，别混），含主人档案与行为铁律

---

## 三、关键机制速查（新会话最容易忘的）

### 登录状态机
`wechat_bind_this_conversation` 返回二维码后**没有任何东西自动轮询**。
扫码确认后如果没绑定成功，手动推：
```
POST http://127.0.0.1:19387/dsh-wechat-clawbot/login/status   （空 body，每 2 秒一次直到 confirmed）
```

### 改绑（不用重扫）
```
POST http://127.0.0.1:19387/dsh-wechat-clawbot/bind
{"sessionId": "<目标会话id>"}     ← 不传 userId 改绑所有已有联系人
```

### 限流（ret=-2 prepare failed）
- **是 bot 级突发限流**，不是 context_token 问题（带不带 token 结果一样）
- 处罚期内**继续发送会加重处罚**——所以熔断期间本地直接拒绝，绝不重试
- 回复路径不受限；主动推送受限
- 解除：等窗口滑过（可能按小时计）、`/push/reset`、或重扫码换新 bot 会话

### 测试
```
cd dsh-wechat-clawbot
npm test     # 21 自检 + 63 集成，最后两层因缺 DSH 依赖按设计跳过
```

---

## 四、已知问题 / 待办

1. **未提交的限流防护批次**（见「当前状态快照」）——最紧要的收尾。
2. **`sessionAlive` 误判**：活跃会话写日志的瞬间探测可能失败 → 绑定被误删、
   消息进兜底会话。恢复手段：`/bind` 接口。根治要加宽限重试，未做。
3. **回复收集按会话不按轮次**：超长思考（>5 分钟）触发的超时会让下一个消息的
   收集器接住上一轮的 turn/end，产生错位回复。用户已确认影响可接受，未修。
   修法设计（若要修）：按 `turn/start` 事件记录轮次号，waiter 只认大于
   「创建时已开始轮次」的事件。
4. **生图工具的 image 块自动推微信不可靠**（绑定正确也可能收不到），
   可靠路径是 `scripts/_push-image.mjs`。未查明根因。
5. **`wechat_schedule` 没有取消接口**：登记后无法撤销（`/idle/cancel` 只撤心跳）。
   AI 的应对是「到点装死不发」；值得加 `POST /idle/schedule/cancel` 路由。
6. **`._push-*` 脚本未入库**（见快照）。

---

## 五、周边生态（不属于本仓库，但强相关）

- **`.memory/`**（工作区根）：大肥鱼角色的持久记忆。core-memory.md 里有
  主人档案、微信说话铁律（盖章、条数边界、emoji 黑名单）、运维手册。
  **更新 skill 或插件时别把它当垃圾清了**。
- **`dafeiyu/`**：角色 skill（SKILL.md + references + assets）。
  已独立于微信插件，平台无关。聊天礼仪的「盖章」「发送不可信」等
  就是从本插件的坑里提炼的。
- **`dsh-ujn-image`**（系统里另一个插件）：设置页集成的参考模板
  （`order: 42`，本插件用 43 排它后面）。

---

## 六、给接手者的三句话

1. **先跑 `npm test`**——63 项集成测试是插件行为的唯一权威描述，
   比任何文档都新。
2. **改完要重启 DSH**——插件代码由桌面端进程加载，本地改完不重启等于没改；
   大肥鱼自己修 bug 时就吃过「改了没生效」的亏。
3. **这是给真人用的陪伴型 bot**——所有设计取舍（待机只是提醒、静默熔断、
   配额）的出发点都是「别骚扰用户」。往里加功能时先问：这会不会变成打扰。
