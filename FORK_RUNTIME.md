# FORK_RUNTIME — 这个 fork 在泽豪的环境里跑在哪

**新文件、fork 独有**,上游没有,所以合并永不冲突。放在仓库里而不是 vault 里,是因为升级 / 同步会话是在**这个仓库**里工作的,放 vault 它们看不到。

记录的是**运行时拓扑与环境陷阱**——那些「读代码读不出来、但读错了会白查半天」的事实。fork 的代码缺陷记在 `FORK_BACKLOG.md`,架构决策记在 vault 的 `DECISIONS.md`(ADR 唯一真源),都不在这里。

---

## 三台机器,别搞混

| 主机名 | 内网 IP | 角色 | 端口 |
|---|---|---|---|
| `nas.myhome` | **192.168.50.232** | NAS —— gbrain 的 Postgres 库 `gbrain_qwen2000` | `55432`(**11434 是关着的,embedding 不在这台**) |
| `windows.myhome` | **192.168.50.124** | 家庭服务器(7×24)—— embedding + LLM + reranker | `11434` ollama · `8081` reranker · `4000` LiteLLM/Vertex 网关 |
| 本机 | — | 泽豪的个人电脑 | **不承载 gbrain 任何运行时依赖** |

**为什么模型层刻意不跑在本机**(别再问用户):本机是打游戏的电脑,跑 gbrain 会抢 GPU;打游戏经常重启,而本机 ollama 开机不自启,每次都要手动开。所以一劳永逸迁到 7×24 家庭服务器,让 gbrain 完全脱离本机开关机状态。reranker 迁出本机是同一个动机链。

配置落在三处,改端点要三处一起看:

- `~/.gbrain/config.json` → `database_url`、`provider_base_urls.ollama`、`provider_base_urls["llama-server-reranker"]`
- 仓库根 `.env` → `NAS_IP`(**名字有误导性:它的值历史上是主机名而不是 IP**)
- `.env` 里还有 `GBRAIN_AI_EMBED_TIMEOUT_MS=180000`、`GBRAIN_EMBED_CONCURRENCY=4`

`~/.gbrain/config.json` 不在 git 里。改之前先 `cp config.json config.json.bak-<日期>-<原因>`。

---

## `*.myhome` 走 Surge Ponte —— 解析成 `198.18.x.x` 是正常的

`198.18.0.0/15` 是 Surge 的 fake-IP 段。看到 `nas.myhome` 解析成 `198.18.111.238` **不要当成 DNS 被污染或配置错误**,那就是 Ponte 的工作方式(2026-08-17 泽豪确认)。

### 陷阱一:fake-IP 下端口探测是系统性假阳性

```
nc -z nas.myhome 55432   →  "succeeded"     ← 骗人的
psql -h nas.myhome …     →  timeout expired ← 真相
```

Surge **代替目标主机接下了 TCP 握手**,之后才在隧道里失败。所以 `nc`/`telnet`/`curl --connect-timeout` 这类只看连接是否建立的探测,在这套网络下一律不可信。**判端点通不通,只能发一次真实协议请求**(psql 查一行、`/v1/models`、`/v1/embeddings`)。

### 陷阱二:Ponte 一挂,全部 `*.myhome` 同时不可达

现象:cron 日志刷 `Cannot connect to database: write CONNECT_TIMEOUT nas.myhome:55432`。

应急处置——把主机名换成上表的内网真实 IP(2026-08-17 就是这么做的),Ponte 恢复后可以换回去。这不是永久修复,是绕过。

---

## 定时任务

| launchd 标签 | 干什么 | 现状 |
|---|---|---|
| cron 包装脚本 `~/.local/bin/gbrain-cron-sync.sh` | 每 30 分钟 `bun src/cli.ts sync` | **在跑** |
| `com.xasxcy.gbrain-upstream-sync` | 原先每天 10:30 跑上游同步脚本 | **已不存在**：`~/Library/LaunchAgents` 里只剩 `com.xasxcy.gbrain-upstream-sync.plist.bak-20260720T122831`（2026-10-20 核实）。自动同步基本完不成，上游同步一律手动做。 |

早期停用的背景见 `FORK_BACKLOG.md` 与 vault ADR-087。手动同步时不再给 fork 迁移改号，fork 迁移有自己的计数器，见下面“排障”里的迁移编号一条。

**这个仓库没有 build 步骤(ADR-070):工作区就是生产代码。** 存盘即上线,下一轮 cron 直接执行。所以改到一半的树 = 线上跑着改到一半的代码。

cron 包装脚本自带两道闸,知道它们在,别重复造:

- `~/Library/Logs/gbrain-sync.paused` 里写着持有者 pid,该 pid 活着就跳过这一轮;pid 死了的残留标记会被忽略,所以杀进程不会永久卡住 cron。
- `MERGE_HEAD` 存在时直接拒跑,不碰半合并的树。

包装脚本里 embed 相关的环境变量(2026-10-20 调过):`GBRAIN_EMBED_TIME_BUDGET_MS=600000`(10 分钟)、`GBRAIN_EMBED_CONCURRENCY=4`、`GBRAIN_AI_EMBED_TIMEOUT_MS=180000`、`GBRAIN_EMBEDDING_IMAGE_OCR=false`。

- OCR 关掉的原因:OCR 模型调用失败时,缺 OCR 文字的图片每一轮都会被重建,每次重建都要付费调用 DashScope 多模态接口。
- 10 分钟预算同时约束图片 sweep 和文字 drain,两者共用一个时间窗口。
- 字节没变、而且 `visual_model` 标记与当前模型一致的图片,重建时直接复用已有向量,不再付费。

日志:`~/Library/Logs/gbrain-sync.log`。注意**只有「跳过」的轮次才带时间戳**,正常开跑的轮次不带,所以不能靠时间戳行数数轮次。

---

## 排障时先看这几条

- **「Embedded 0 chunks … eligible_now=N」连续多轮重复** → 大概率是 `FORK_BACKLOG.md` FB-002(退避账本对 transient 失败不可达,导致无界重试),不是 provider 的锅,别去追 provider。
- **`embed_failures` 表里的 failures 计数** → 那是**下一轮正常重试**的条目,不是需要人工干预的东西。只有 `quarantined_at` 非空的才要人管。
- **验证 embedding 端点时,必须用库里的真实 chunk,不能用合成文本。** 2026-08-17 实测,同样 32 条、同样字节数:

  | 输入 | 耗时 |
  |---|---|
  | 合成文本(`测试文本 ` 重复) | **12 秒** |
  | 真实 chunk(中文技术文+代码) | **>120 秒,超时** |

  差 22 倍。重复文本几乎不产生 token 负载,字节数对得上不等于负载对得上。真实内容约 **8.2 秒/chunk 且线性**,所以 32 条一批 ≈ 262 秒,已经超过 `GBRAIN_AI_EMBED_TIMEOUT_MS=180000`——**这类批在数学上就跑不完,重试多少次都一样**。判端点健不健康,拿真实 chunk 打。
- **fork 迁移和上游迁移各用一个计数器。** 上游迁移由 `config.version` 门控，只记上游编号；fork 迁移（`src/core/fork-migrations.ts`）由 `config.fork_schema_version` 门控，编号从 1 起，日志里显示为 `[fork#N]`。
  - 已发布的 fork 迁移永不改号、改名、删除，新的只追加在末尾。`scripts/check-fork-migration-masking.sh` 和 `test/fork-migrations-golden.test.ts` 守着这一条。
  - 旧库第一次连上新代码时一次性切换：`version` 在 261–275 的改成 `version=260`、`fork_schema_version=version−260`；不超过 260 的，`fork_schema_version=0`；超过 275 的拒绝启动。
  - 回滚到共享计数器的旧代码：`version` 改回 `260 + fork_schema_version`（当前是 275），删掉 `fork_schema_version` 这个键。
  - 部署时旧二进制（`bin/gbrain`、常驻的 `gbrain serve`）必须一起换掉：旧代码看到 `version=260` 会以为 261–275 没跑，把 fork 迁移重跑一遍。
  - 上游迁移可能删掉 fork 建的对象（PGroonga 索引、`files_source_storage_key`），每次迁移结束时 `healForkDrift` 会探测，缺了就只重装对应的那一条 fork 迁移。
- **`schema_version` 对得上不代表迁移都跑过。** runMigrations 用的是单个高水位整数，不是已应用集合；改用独立计数器之前，被 fork 同号占掉的上游迁移会被永久静默跳过。要确认就做对账式检查：解析迁移声称创建的对象，逐个查生产 catalog。见 vault ADR-087。
  - 每次启动的 schema 重放（`CREATE/ADD ... IF NOT EXISTS`）会悄悄补上一部分被跳过的迁移，所以“被跳过”和“留下缺口”是两回事；已知缺口由 `src/core/fork-migrations.ts` 里的 `repair_masked_*` 迁移补，最早的一段（上游 117–122）由 fork#15（旧编号 v275）补。
  - 全新库 vs 迁移库的 catalog 对比看不到两类东西：视图的 `reloptions`（例如 `page_links` 的 `security_invoker`）和纯数据语句（`setval`、`UPDATE`）。这两类要单独查。
  - 不要整段重放旧迁移：后来的迁移可能已经删掉它建的东西（v188 删了 v122 的索引），或它会 `ALTER` 运行角色不拥有的对象（`auto_enable_rls`、`page_links` 归 postgres）。
