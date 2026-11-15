# TunnelWorker 待办与风险审查清单

> 审查日期：2026-11-15（北京时间）
>
> 审查基线：`main` — [`5546ed9`](https://github.com/tanwaikin/TunnelWorker/commit/5546ed9fa4e98d0552b1ac4846e45ef8759ac894)（在 `v0.1.0` 基础上新增 HTTP 排队机制）。
>
> 用途：集中跟踪代码审查发现的风险、尚未完成的真实云端验收及体验改进。**本文件是待办清单，不代表这些风险已在生产环境复现。** 不包含生产凭据、个人域名或账号配置。

## 已确认的进展与范围

- WSS 控制连接已从覆写 HTTP Host 改为路径路由 `GET /api/tunnels/{id}/connect`；通过真实 Codex Cloud 环境获得 HTTP 101 的测试有记录。
- 公网入口改为一级子域名 `https://{id}-tunnel.<VISITOR_DOMAIN>`；`docs/HANDOFF.md` 记录了 HTTPS 200 和正常 TLS 校验。
- 已实现按 Tunnel ID 隔离的 SQLite Durable Object、Connector 自动重连、认证、绝对过期和 HTTP/应用 WebSocket 转发。
- 最新 `main` 的 HTTP 转发并发上限改为 **8**，额外排队 **32** 个、最长等待 **15 秒**。最新提交的 GitHub Actions CI 成功，**不能代替真实云端压测**。
- `v0.1.0` 已发布；最新排队功能暂未包含在 `v0.1.0` tag 对应的源码与构建包中。

## 优先级与状态

- **P0**：影响稳定性、安全性或开发隧道核心用途，优先验证或修复。
- **P1**：上线运营、资源清理与实际用户体验问题。
- **P2**：文档、观测能力和后续增强。
- **状态**：默认 `待验证` / `待修复` / `规划中`；完成时注明验证命令、环境、提交链接。

| ID | 优先级 | 状态 | 待办 |
| --- | --- | --- | --- |
| TW-001 | P0 | 待验证 | 并发大请求可能触发 Durable Object 内存峰值过高 |
| TW-002 | P0 | 待验证 | HTTP 排队、取消、超时和重连的边界条件 |
| TW-003 | P0 | 待验证 | 新一级公网域名下真实应用 WebSocket / HMR |
| TW-004 | P1 | 待设计 | 到期 DO 存储清理与随机 ID 探测 |
| TW-005 | P1 | 待实现 | 随机 Tunnel ID 的 DNS 记录自动配置或入口方案 |
| TW-006 | P1 | 待审查 | 默认公开开发服务的访问安全与速率限制 |
| TW-007 | P1 | 待验证 | 多 Connector 共用默认 Session 文件的冲突风险 |
| TW-008 | P1 | 待验证 | 自定义 `--domain` 导致管理 API 的 Host 与实际 URL 不一致 |
| TW-009 | P1 | 待验证 | 真正的自然到期、长连接重连和流式响应的云端长期验收 |
| TW-010 | P2 | 待更新 | 版本、部署文档和发布状态一致性 |
| TW-011 | P2 | 规划中 | Tunnel 运行状态、错误与资源消耗观测 |

---

## TW-001 — 并发大请求的内存峰值

**优先级：P0；性质：源码可见的风险，尚未压测复现。**

**证据**：[`src/index.ts`](../src/index.ts) 的 `http()` 在获得并发槽位后，把整个 HTTP 请求体读取到 `chunks: Uint8Array[]`，随后复制到新分配的 `Uint8Array(length)`，再按 36 KiB Base64 编码并发送；`MAX_ACTIVE_HTTP = 8`、`MAX_QUEUED_HTTP = 32`。`config.maxBody` 最大 8 MiB。

**风险**：8 个请求各上传 8 MiB 时，`chunks` 与完整复制数组理论上就可能同时占用约 128 MiB（未计 JSON/Base64、Worker 其他状态、运行时开销），导致高峰内存、请求异常或实例重启。实际内存和是否超限需要在真实环境测量。

**建议**：
1. 为 1/4/8 并发、1/4/8 MiB 请求体增加压力测试，统计完成率、峰值内存、响应时间与失败类型。
2. 优先设计请求体**有界流式分块**，利用 ACK/背压，避免同时持有两份完整上传体。
3. 在实现流式协议前，如必须限制风险，可临时降低并发或最大请求体；须记录吞吐量取舍。

**验收标准**：在约定的最高支持并发和请求体大小下，所有请求能完成或收到明确的受控错误；无 DO 内存超限、失控重试、数据不一致，且有可复现的测试记录。

## TW-002 — HTTP 队列与取消的边界条件

**优先级：P0；性质：新增功能的测试缺口及潜在资源释放问题。**

**证据**：[`src/index.ts`](../src/index.ts) 的 `acquireHttpSlot()`、`releaseHttpSlot()`、`waitResponse()` 和 `expire()`；[`test/integration.test.ts`](../test/integration.test.ts) 已覆盖第 9 个请求排队、释放后转发，以及过期时队列清理，但尚缺系统化边界矩阵。

**重点测试**：
- 8、9、40、41、100 个并发请求：前 8 个转发，最多 32 个排队，其余返回受控的 503 + `Retry-After`。
- 队列等待超过 15 秒：超时响应，超时项从队列移除。
- 排队期间客户端断连或取消；分配槽位后、收到响应头后、响应流未被消费/中途取消。
- Connector 在排队期间断线、重连或被替换；全部未完成请求和槽位最终能释放。
- 过期/撤销发生于队列等待、请求上传、响应流式传输时。
- 慢消费者：验证 `http_ack`、背压和 `release()` 不会遗漏或重复执行。

**特别注意**：`waitResponse()` 在收到 `http_start` 后移除 `AbortSignal` 监听；需要确认浏览器断连时是否总能触发 `ReadableStream.cancel()`，否则可能长时间占用 `activeHttp` 槽位。此处是待证实的生命周期风险，不能直接认定存在泄漏。

**验收标准**：测试涵盖溢出、超时、取消、断连、重连、过期及重复释放；请求完成或退出后，队列和活动槽位均可恢复到预期值；失败可区分 `tunnel_overloaded`、`tunnel_queue_timeout` 等错误。

## TW-003 — 新公网域名下真实 WebSocket / HMR 验收

**优先级：P0；性质：真实云端验收缺口。**

**证据**：[`docs/HANDOFF.md`](HANDOFF.md) 已确认一级子域名 HTTPS + 静态 HTTP 200，但明确记载公网应用 WebSocket、流式响应和密码/Cookie 流程未在该部署上完成全套验证。

**建议**：
1. 在有效 TLS 证书和真实公网访问方式下，启动支持 WebSocket/HMR 的本地服务。
2. 从真实浏览器验证 WebSocket 101、文本/二进制消息、子协议、关闭事件、HMR 热更新。
3. 测试设置访客密码后的 HTTP Basic/Cookie 引导和浏览器 WS 握手，以及未经授权的拒绝行为。
4. 分别记录客户端侧、Worker/DO 侧和 Connector 侧的结果，定位任何 502/503。

**验收标准**：在真实云端链路上完成 HTTP + WebSocket/HMR + 带密码访问的闭环，并明确使用的提交、部署版本及测试时间。不得把本地 Vitest/Smoke 成功当作公网成功。

## TW-004 — 到期 DO 的持久存储及未知 ID 探测

**优先级：P1；性质：可确认的实现行为 + 待量化的成本风险。**

**证据**：[`src/index.ts`](../src/index.ts) 的 `Tunnel` 构造器创建 SQLite `tunnel` 表，`expire()` 只 `DELETE FROM tunnel` 并 `deleteAlarm()`。Worker 对符合格式的任意 ID 使用 `env.TUNNELS.getByName(id).fetch(request)`，不存在的 ID 也可能触发 DO 初始化。

**风险**：过期或被探测的随机 DO 可能保留空数据库/元数据。是否形成显著成本需根据实际 SQLite 存储量、请求量及平台计费验证。

**建议**：
1. 验证到期、主动撤销、未知 ID 首次访问后的存储行为及计费指标。
2. 设计可靠清理：对过期对象评估 `storage.deleteAll()`，但须同步验证构造器初始化、重复请求和 Alarm 行为。
3. 评估是否要通过集中登记表/索引拦截未注册 ID；需权衡查询成本、复杂度与随机 ID 不可枚举性。
4. 保持身份验证和过期校验，不允许重新激活已删除凭据。

**验收标准**：过期/撤销不会遗留非预期持久数据；未知 ID 的探测成本有量化上界；所有相关行为均有测试。

## TW-005 — DNS 自动化与即开即用

**优先级：P1；性质：确认的产品体验缺口。**

**证据**：[`README.md`](../README.md) 和 [`docs/HANDOFF.md`](HANDOFF.md) 说明新建随机 `{id}-tunnel.<VISITOR_DOMAIN>` 地址需单独创建代理 DNS 记录，CLI 当前不会代建。

**风险**：API 创建成功，但返回的 HTTPS URL 在 DNS 配置完成前不可直接访问，违背“一条命令获得可用预览 URL”的预期。

**方案比较**：
- **方案 A**：显式 DNS 自动创建/回收；需要最小权限 DNS API Token、失败回滚和到期清理。
- **方案 B**：父域通配符 DNS；配置简单，但扩大 DNS 命中范围，应明确处理非 Tunnel 主机名、防滥用和证书覆盖。
- **方案 C**：固定域名别名或预分配域名池；适合自用，但须增加唯一性及映射管理。

**验收标准**：创建后 URL 无需手工配置即可有效访问（或 CLI 明确提示 DNS 未就绪）；回收时无多余 DNS 记录；不泄露 Cloudflare API Token；未获授权不修改用户 DNS。

## TW-006 — 默认公开开发服务的安全提示与限制

**优先级：P1；性质：代码支持匿名访问时的既有安全模型，不是认证绕过漏洞。**

**证据**：[`src/index.ts`](../src/index.ts) 使用可选 `visitorPassword`；不配置时公网访客无需密码。

**风险**：Codex Cloud 本地开发应用可能包含未保护的管理 API、调试页面、文件下载、内部错误信息等。

**建议**：
1. 在 CLI/README 明确显示“当前 Tunnel 为公开访问”，并推荐设置 `--password`。
2. 对公开共享场景评估 Cloudflare Access、IP 访问规则、速率限制和审计日志。
3. 验证 `Authorization`、Cookie、`X-Tunnel-Password` 的转发和剥离行为，不把 Tunnel 认证凭据交给本地应用。
4. 不将临时预览链接误认为私有地址；保护 Operator Token、Connector Token、DNS Token。

**验收标准**：默认公开行为有显眼提示；设置密码时未认证 HTTP/WS 被拒绝；转发协议不会意外泄漏隧道凭据。

## TW-007 — 多实例默认 Session 文件冲突

**优先级：P1；性质：潜在使用冲突，需复现。**

**证据**：[`cmd/tunnelworker/main.go`](../cmd/tunnelworker/main.go) 支持 `--session-file`，默认使用固定会话路径；[`internal/session/session.go`](../internal/session/session.go) 按给定路径原子保存凭据。

**风险**：用户同时启动多个 CLI，未指定不同 Session 文件时，可能相互覆盖或误删重连凭据；但这与连接协议独立。

**建议**：
1. 使用两个并行 Connector 实例在默认参数下创建 Tunnel，核实文件覆盖/退出清理。
2. 提供基于 Tunnel ID 的默认 Session 文件路径、进程锁或明确的单实例保护。
3. 对显式共享的 `--session-file` 给出错误提示，保持文件权限 `0600`。

**验收标准**：两个独立 Tunnel 同时运行、重连、退出互不影响；异常终止后凭据可安全恢复。

## TW-008 — 管理 API 的 Host 选择与代理兼容性

**优先级：P1；性质：条件触发的潜在兼容性问题。**

**证据**：[`internal/tunnel/agent.go`](../internal/tunnel/agent.go) 的生产 WSS 控制连接已使用 URL Host；但 [`internal/control/client.go`](../internal/control/client.go) 的 Create/Revoke 仍设置 `req.Host = c.domain`，以兼容本地 Wrangler 虚拟主机。

**风险**：指定与实际 `--url` 不同的 `--domain` 时，管理 API 可能再次出现 TLS SNI / HTTP Host 不一致；旧控制连接曾在 Codex Cloud 代理下遇到 Envoy 503，但不能据此断定此场景必然失败。

**建议**：
1. 加测试：生产同域、生产异域、自定义域、本地 Wrangler loopback。
2. 生产管理 API 默认采用实际 URL hostname；只在明确本地测试模式下覆写 Host。
3. 若 `--domain` 仍需影响公网 URL 生成，应与网络拨号域名、HTTP Host 功能拆开。
4. 保持 TLS 证书验证，不用 `InsecureSkipVerify` 绕过。

**验收标准**：生产 HTTP 管理 API 和 WSS 控制连接的目的 Host 一致；自定义参数行为明确；本地测试不回退。

## TW-009 — 自然过期、断连和长时间运行的真实云端验收

**优先级：P1；性质：真实环境测试覆盖缺口。**

**证据**：[`docs/HANDOFF.md`](HANDOFF.md) 记录了重连保持原始到期时间、主动撤销，以及新版公网域名 HTTPS 成功；但仍缺自然 TTL 到期的真实等待测试及较长时间连续运行记录。

**建议**：
1. 分别以最短和默认 TTL 创建测试 Tunnel，等待自然到期而非主动撤销。
2. 验证 Alarm、HTTP 410、WSS 关闭、凭据失效、Session 回收。
3. 进行 30–60 分钟（以及业务需要的更长时长）的正常运行、断线重连、低流量休眠唤醒测试。
4. 验证不同重连节奏与浏览器慢速读取下的流式响应完整性。

**验收标准**：自然过期、异常断线、休眠唤醒和流式转发均通过真实 Cloudflare 部署测试，附可复现操作与日志。

## TW-010 — 发布版本与文档同步

**优先级：P2；性质：确认的文档维护事项。**

**证据**：
- [GitHub Release v0.1.0](https://github.com/tanwaikin/TunnelWorker/releases/tag/v0.1.0) 已发布。
- 当前 `main` 的 [`5546ed9`](https://github.com/tanwaikin/TunnelWorker/commit/5546ed9fa4e98d0552b1ac4846e45ef8759ac894) 比 `v0.1.0` 多出 HTTP 排队功能。
- [`docs/HANDOFF.md`](HANDOFF.md) 的“尚未推送 Release tag”“仓库仍为私有”等历史文字已过时。

**建议**：
1. 标记历史部署测试的准确版本，更新当前公开状态与发布情况。
2. 在 README/Changelog 清楚区分 v0.1.0 功能与尚未发布的 main 改动。
3. 后续发布版本时增加跨平台下载、Checksum 校验和升级注意事项检查。
4. 不要因为文档整理自动打 tag 或发布新版本。

**验收标准**：用户能够明确知道当前稳定 Release、主干新功能、实测边界及部署升级步骤。

## TW-011 — 可观测性与故障定位

**优先级：P2；性质：能力增强。**

**证据**：[`wrangler.jsonc`](../wrangler.jsonc) 已启用 observability/traces，但尚无完整的面向单条 Tunnel 的在线状态、队列深度、请求失败分类、流量统计及管理 CLI。

**建议**：
1. 为控制握手、DO 路由、Connector、Origin 四个层次定义结构化事件，不输出凭据、Cookie 或敏感正文。
2. 暴露受认证保护的 `status` / `list` 信息或 CLI 命令；避免公共健康接口泄漏 Tunnel 列表。
3. 记录活跃/排队请求数、HTTP 状态码、转发时延、字节数、重连次数和最近错误。
4. 为 503 明确区分 Cloud 代理、Worker、DO 过载、Connector 离线和本地 Origin 故障。

**验收标准**：出现一次 503 时，可以从非敏感诊断信息确定失败所在层；指标不会造成不可控的存储成本。

---

## 建议执行顺序

1. **先补测试**：TW-002 队列与取消 → TW-001 并发大请求内存 → TW-003 真实公网 WebSocket/HMR。
2. **再修生命周期**：TW-004 DO 清理与未知 ID → TW-009 自然到期。
3. **改善日常体验**：TW-005 DNS 自动化 → TW-007 多 Session 隔离 → TW-008 Host 配置一致性。
4. **公开使用与维护**：TW-006 安全提示/限制 → TW-010 发布文档 → TW-011 可观测性。

> 修复前为每项补可复现的失败用例；修复后以对应测试、实际 Cloudflare 验证（如需要）和提交链接关闭待办。不要把“尚未覆盖的测试”直接表述成“已经存在的漏洞”。

## 参考

- [最新排队机制提交：5546ed9](https://github.com/tanwaikin/TunnelWorker/commit/5546ed9fa4e98d0552b1ac4846e45ef8759ac894)
- [WSS 路径路由提交：e6406d3](https://github.com/tanwaikin/TunnelWorker/commit/e6406d33b23ff2326e223b18ebd40fd23c9793c1)
- [一级子域名提交：4b759c2](https://github.com/tanwaikin/TunnelWorker/commit/4b759c21835febd5232b74badaa44a5b2c9f8f27)
- [CI Workflow](../.github/workflows/ci.yml)
- [真实环境验收与遗留问题](HANDOFF.md)
