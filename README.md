# 多人协同批注编辑器

基于 **Vue3 + TypeScript + Pinia + Element Plus + WebSocket** 的多人轻量协同批注编辑器。
多人同时编辑 / 批注同一文档，使用 **OT（Operational Transformation）** 解决并发冲突，
支持只读 / 批注 / 编辑三种权限，具备断网重连、消息丢失检测与状态回滚能力。
内置**文档导入导出与异步转换中心**：多格式导入预览确认、三变体导出、长耗时转换的
任务追踪 / 重试 / 取消与全流程操作审计。

## 功能一览

- **实时协同编辑**：多人在线编辑同一文档，操作经 OT 变换后收敛一致
- **划词批注**：选中文字添加批注，支持回复、解决、删除；批注锚点随编辑自动移动
- **三级权限**：`editor`（编辑+批注）/ `commenter`（仅批注）/ `viewer`（只读），服务端逐条校验
- **在线状态**：在线用户列表、远程光标与选区实时展示
- **异常链路**：断网自动重连（指数退避）、离线编辑暂存、消息序号空洞检测、ack 超时重同步、版本过旧时全量快照回滚
- **文档导入**：TXT / Markdown / HTML / DOCX 上传后**先解析预览、再结构差异比对**，用户确认后才作为一条协同变更进入版本体系，绝不直接覆盖正文
- **文档导出**：当前版本 / 历史版本 / 带批注版本，导出 TXT / Markdown / HTML / DOCX
- **异步转换中心**：长耗时转换任务排队执行，支持进度追踪、失败退避重试、手动重试、任务取消，全部操作落审计日志
- **演示工具栏**：一键「模拟断线 / 重新连接」，直观展示离线编辑与重连同步

## 快速开始

```bash
# 1. 安装依赖（根目录 + server + client）
npm run setup          # 或分别 npm --prefix server install && npm --prefix client install
npm install            # 根目录 concurrently（仅 dev 需要）

# 2. 开发模式（server:8080 + vite:5173，ws 已配置代理）
npm run dev

# 3. 打开 http://localhost:5173 ，多开几个标签页选择不同身份加入同一文档
```

生产模式：

```bash
npm run build          # 构建客户端到 client/dist
npm start              # 服务端托管 API + 静态页面：http://localhost:8080
```

测试与类型检查：

```bash
npm test               # OT 单元测试（含随机 fuzz 收敛性）+ 服务端 e2e（并发/权限/重连/快照）
npm run typecheck      # server tsc + client vue-tsc
```

## 目录结构

```
├── shared/               # 前后端共享代码
│   ├── ot.ts             #   OT 核心：apply / transformPair / compose / invert / mapPosition / diffToOp
│   ├── protocol.ts       #   协议类型：角色、批注、全部 WS 消息
│   ├── transfer.ts       #   转换中心协议：格式/任务/审计/预览差异类型与限额常量
│   └── linediff.ts       #   行级结构差异：LCS 动态规划 → Hunt-Szymanski → 公共前后缀降级 + 上下文折叠
├── server/
│   └── src/
│       ├── docSession.ts #   文档会话：版本日志、OT 变换、批注锚点、权限、重同步、历史快照与导入提交
│       ├── index.ts      #   HTTP + WS 入口、心跳、静态托管、文件持久化、任务中心装配
│       ├── convert/      #   编码探测 / htmlParser / docxParser（ZIP+OOXML）/ 四格式导出器（含 docx 生成）
│       ├── tasks/        #   taskManager（队列·重试·取消·TTL·持久化）/ jobs（执行体）/ audit（JSONL）
│       └── http/         #   REST 路由 + 极简 multipart 解析
│   └── test/             #   ot.test.ts（性质 fuzz）/ convert.test.ts（转换·任务·历史版本）
│                         #   e2e.test.ts（并发·权限·重连）/ api.test.ts（导入导出全链路 REST+WS）
│                         #   otClient.e2e.ts（真实客户端 OTClient × 真实服务端集成）
└── client/src/
    ├── collab/collab.ts  #   编排层：连接 × OT × store，异常链路处理
    ├── ot/otClient.ts    #   OT 客户端状态机（未确认队列 / 发送节流 / ack 超时）
    ├── ws/wsClient.ts    #   WS 封装（自动重连 / 发送队列 / 心跳）
    ├── transfer/         #   REST API 客户端
    ├── stores/           #   Pinia：session / doc / transfer（任务轮询·审计）
    └── components/       #   EditorView / AnnotationPanel / TopBar / LoginGate
        └── transfer/     #   转换中心抽屉：ImportPane / ExportPane / TasksPane / AuditPane
```

## 核心设计

### OT 并发模型

文档为纯字符串，操作是 `retain(n) / insert(s) / delete(n)` 组件序列：

- 服务端为每个文档维护 `revision` 与操作日志（上限 1000 条）。客户端操作携带基准版本号；
  若已落后，服务端将其对落后期间的全部已接受操作**逐个变换**后应用，再广播给其他人。
- 客户端本地乐观应用，未确认操作进入队列（`unacked[0]` 已发送待确认，其余为缓冲，
  连续输入经 `compose` 合并）。远程操作到达时与全部未确认操作做双侧变换。
- 同位置并发插入的先后由「先被服务端接受者优先」的全局约定打破，保证各端收敛。
- 正确性由 `server/test/ot.test.ts` 中的随机 fuzz 性质测试保障
  （`apply(apply(S,a),b') === apply(apply(S,b),a')`、compose 结合律、invert 往返、三方并发收敛）。

### 批注锚点

批注锚定 `[start, end)` 区间。服务端与客户端在每次应用操作时都用 `mapPosition`
移动锚点（起点 `after`、终点 `before`，边界输入不扩选）；锚点文本被完全删除时
批注转为「孤儿」状态（📌 标记，保留原文引用）。

### 断网重连与消息可靠性

| 异常 | 检测 | 恢复 |
| --- | --- | --- |
| 断网 / 假死 | WS close、应用层 ping/pong 心跳（10s/5s） | 指数退避重连（1s→2s→…→15s + 抖动），重连后带 `lastRevision` 重新 join |
| 离线编辑 | — | 编辑进入 OT 队列、批注进入 outbox，重连并重同步后自动补发 |
| 消息丢失（下行） | 广播消息携带单调 `seq`，客户端检测空洞 | 发送 `resync`，服务端按版本补发 `ops`（含按 opId 去重自己的操作） |
| 消息丢失（上行/ack） | ack 5s 超时 | 同上触发 resync |
| 版本过旧 | 服务端日志不足以覆盖客户端版本 | 下发全量快照，客户端**回滚**未确认修改并提示 |
| 权限/协议错误 | 服务端逐条校验返回 `error` | 前端提示，必要时自动 resync |

### 实时推送频率与性能权衡

- **编辑操作**：本地乐观应用零延迟；发送端做 **60ms 节流合并**（`minSendInterval`），
  连续打字合并为一条消息，ack 后立即发送缓冲批次 —— 用可忽略的延迟换取消息数量级下降。
- **光标/选区**：120ms 节流、易失消息（不计 seq、不持久化、断线即弃），不参与可靠性链路。
- **presence**：仅 join/leave 时广播。
- **持久化**：文档变更后 1.5s 防抖写盘（`server/data/*.json`），重启自动恢复。
- **渲染**：高亮层按「边界切分」一次计算 HTML，避免逐字 span；大文档下 diff 为
  公共前后缀算法，单点编辑 O(1) 生成操作。

### 文档导入导出与异步转换中心

**导入不碰正文，确认才入版本**：上传文件进入异步导入任务，解析产出「待确认版本」，
与当前正文做行级结构差异（新增/删除/上下文折叠），用户在抽屉中预览、微调后点确认 ——
服务端用 `diffToOp(当前正文, 待确认文本)` 生成一条 OT 操作，经 `submitExternalChange`
走与普通编辑完全相同的提交/广播/锚点变换/持久化路径，在线协作者实时收到变更；
预览一次性消费，防止重复确认。仅 `editor` 可导入。

**格式兼容**（全部零第三方运行时依赖）：

| 场景 | 处理 |
| --- | --- |
| 中文字体 | DOCX 的 docDefaults/run 均声明 `w:eastAsia="宋体"`；HTML 使用 PingFang/雅黑/宋体字体栈 |
| 编码 | BOM 识别（UTF-8/UTF-16）→ 严格 UTF-8 校验 → GB18030/GBK 回退，回退产生显式警告 |
| 超长文档 | 200 万字符截断警告；diff 在 1200 万「格」预算内走 LCS DP，超出切 Hunt-Szymanski，再降级公共前后缀；预览折叠远场上下文 |
| 特殊字符 | 控制字符清洗并计数；HTML/XML 全量转义；导出 txt 带 UTF-8 BOM |
| 链接 | HTML/DOCX 超链接转为 `[文字](url)`；DOCX 导出还原为真正的 hyperlink 关系 |
| 图片 | 转为 `[图片：说明](地址)` 占位并计数（纯文本模型不内嵌二进制） |
| 批注锚点 | 带批注导出：TXT/MD 行内 ① 编号 + 文末清单；HTML `<mark>` 高亮 + 评论区锚链；DOCX 写 commentRange 与 comments.xml；孤儿批注输出 📌 标记；原 Word 批注无法自动锚定，导入时计数警告后丢弃 |

**历史版本**：会话每 50 修订落一份正文快照，日志截断（1000 条）时在截断点补「地板快照」；
任意 ≥ 地板的修订都可由「快照 + 操作重放」重建。重启后内存日志清空，仅当前修订可导出。

**异步任务**：`pending → running →（retrying → running…）→ succeeded/failed/canceled`。
确定性错误（文件损坏、格式不支持、修订不存在）不重试；瞬时错误按 1s/4s/9s 指数退避自动重试，
上限 3 次，终态后可手动重试。排队/等待重试中的任务立即取消；执行中通过 `CancelToken`
协作式取消（转换各阶段设取消点），另有 120s 执行超时兜底。任务记录防抖落盘（tasks.json），
重启后导出任务自动重排队、导入任务因源字节仅存内存而置失败。导出产物保留 30 分钟、
任务记录保留 24 小时。

**审计**：提交导入 / 确认导入 / 放弃 / 创建导出 / 下载 / 重试 / 取消 / 失败均写
`data/_transfer/audit/audit-YYYY-MM.jsonl`（按月滚动），含操作者、角色、格式、版本跳转与结果。

### 已知取舍（轻量化的边界）

- 单文档模型为纯文本（非富文本），编辑器用 `textarea + 高亮背景层` 实现，
  避免 contenteditable 的选区/IME 复杂度；IME 组合输入期间不做 diff。
- 服务端为单进程内存状态 + 文件持久化；多实例部署需引入共享存储与消息总线。
- 角色在加入时选定（演示用），未实现管理员在线改权；服务端已按消息逐条鉴权，
  接入真实账号体系后可直接复用校验点。
- 导入导出建立在纯文本模型上：Word 字体/字号/颜色等排版样式与原 Word 批注无法进入模型，
  以显式警告告知；图片不内嵌只留占位；老式 .doc/.wps 不支持（明确拒绝并提示另存 .docx）。
- 历史版本依赖内存快照与操作日志：只保留最近 1000 个修订的操作（加周期快照），
  服务重启后历史版本清空、仅当前版本可导出；需要长期版本归档可把快照持久化到磁盘。
- 转换任务为单进程并发 2 路，导入源字节存内存（≤50MB/个，失败任务仅留最近 10 份负载），
  面向轻量/演示部署；多实例需外置对象存储与任务队列。
- 批注锚点在「本地未确认操作 + 并发远程操作」的极端交错下可能与服务端有字符级偏差，
  任何重同步都会以服务端为准收敛。

## 协议摘要

客户端 → 服务端：`join`（含 lastRevision）/ `op`（含 opId+revision）/ `cursor` /
`ann:add|reply|resolve|delete` / `resync` / `ping`

服务端 → 客户端：`welcome`（snapshot 标志 + seq）/ `ops`（增量补发）/ `ack` / `op` /
`presence` / `cursor` / `ann:upsert|delete` / `error`（PERMISSION_DENIED、RESYNC_REQUIRED…）/ `pong`

## REST 摘要（转换中心，端口同服务端）

身份通过 `x-user-name`（RFC5987 百分号编码）/ `x-user-role` 请求头传递，与 WS join 同一演示身份。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/docs/:docId` | viewer+ | 文档信息与可导出历史修订点 |
| POST | `/api/docs/:docId/imports` | editor | multipart 上传，创建导入任务（202） |
| POST | `/api/docs/:docId/imports/:taskId/confirm` | editor | 确认导入 → 提交协同 OT 变更 |
| POST | `/api/docs/:docId/imports/:taskId/discard` | editor | 放弃预览 |
| POST | `/api/docs/:docId/exports` | viewer+ | 创建导出任务（format × variant） |
| GET | `/api/docs/:docId/tasks[?full=id]` | viewer+ | 任务列表（默认裁剪预览重字段） |
| POST | `/api/docs/:docId/tasks/:taskId/cancel` / `retry` | viewer+ | 取消 / 手动重试 |
| GET | `/api/docs/:docId/tasks/:taskId/download` | viewer+ | 下载导出产物（30 分钟有效） |
| GET | `/api/docs/:docId/audit` | viewer+ | 当前文档审计记录（倒序） |
