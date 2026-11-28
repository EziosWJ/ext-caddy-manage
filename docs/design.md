# ext-caddy-manage 设计

状态：已实现（v0.1.0，2026-11-25）
日期：2026-11-25
目标版本：v0.1.0

本文件是 Caddy 管理插件的实现依据。文中「宿主」指 Extension Host；文中接口以当前工作区的实际实现为准。

## 1. 目标与范围

做一个自托管的 Caddy 运维面板，同时提供轻量的「站点」抽象：

- 服务：状态、启动、停止、重启、热重载、配置校验、版本与模块诊断。
- 配置：主 Caddyfile 的受管全局块 + `conf.d/*.caddy` 站点片段；表单生成与原文编辑并存。
- 站点：静态站、反向代理、重定向；多域名；启用/停用；分组与备注。
- 安全：Basic Auth、压缩、自定义响应头（含 HSTS）、IP 允许/拒绝、目录浏览、SPA 回退。
- 日志：服务日志（journald）与按站点过滤的访问日志；实时跟随由前端轮询实现。
- 证书：Caddy 自动 HTTPS；staging CA 开关；证书签发者与到期时间（TLS 探测）。
- 安全网：写入前备份、校验、原子写入、reload 失败自动回滚、外部修改检测。

明确不做（v1）：

- TCP/UDP 四层代理（需 caddy-l4，官方二进制不含）。
- 限流（需 caddy-ratelimit，官方二进制不含）。
- DNS-01 与通配符证书（需自编译 DNS 模块）。
- 手动上传证书、`tls internal` 内网 CA。
- PHP/FastCGI、文件管理器、FTP、容器、多用户/RBAC、流量统计图表。
- 站点重命名、根目录批量迁移、多 Caddy 实例/多服务器。
- 站点根目录与配置文件的远程管理。

## 2. 部署假设

- Ubuntu 24.04+，systemd，amd64。
- Caddy 使用官方 GitHub Release 的静态二进制，安装到 `/opt/caddy/caddy`，不使用 apt 包。
- 目标版本：Caddy ≥ 2.8（2.8 已具备 `basic_auth`、`hash-password` 非 TTY stdin、`fmt -`/`validate --config -`）。推荐最新 2.x。
- 目录布局：
  - 二进制：`/opt/caddy/caddy`（root:root 0755）
  - 主配置：`/opt/caddy/config/Caddyfile`
  - 站点片段：`/opt/caddy/config/conf.d/*.caddy`，停用片段在 `conf.d.disabled/`
  - 站点根目录：`/opt/caddy/sites/<slug>/`
  - Caddy 状态：`/var/lib/caddy`（Caddy 私有，插件不读）
  - 插件数据（宿主管理）：`<宿主 data-dir>/plugins/de.jianwang.caddy-manage/data`
- 账号：Caddy 以专用 `caddy` 用户运行；配置与站点目录属宿主账号，权限 0755/0644，Caddy 只读。
- 日志：Caddy 运行时日志与访问日志统一写 stderr，由 journald 收集。宿主账号加入 `systemd-journal` 组；unit 关闭 journald 限流（`LogRateLimitBurst=0`），避免高流量时访问日志被丢弃。
- 服务控制：启动、停止与重启通过 `host.services` 传入 `{ sudo = true }`，查询与日志使用宿主账号。非 root 宿主的提权规则由系统管理员配置，示例见 `deploy/sudoers.example`。
- 配置校验/重载/格式化/哈希：通过 `host.process.exec` 调用 `/opt/caddy/caddy`，不需要提权；`caddy reload` 走本机 Admin API `127.0.0.1:2019`。
- 插件不自行安装 unit、不写 sudoers、不改系统账号；`deploy/` 提供 unit、install.sh、系统管理员使用的 sudoers 示例与 README。

### 推荐的 caddy.service

```ini
[Unit]
Description=Caddy
After=network.target

[Service]
User=caddy
Group=caddy
ExecStart=/opt/caddy/caddy run --config /opt/caddy/config/Caddyfile --adapter caddyfile
ExecReload=/opt/caddy/caddy reload --config /opt/caddy/config/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=on-failure
LimitNOFILE=1048576
LogRateLimitBurst=0

[Install]
WantedBy=multi-user.target
```

## 3. 宿主能力依赖（以当前工作区为准）

- `host.services.list/get/start/stop/restart/logs`：查询与日志以宿主账号运行，`{ sudo = true }` 仅用于 start/stop/restart；`logs(unit, lines)` 返回整个 unit 最近 N 行（`journalctl ... -o short-iso`）。
- `host.process.exec(program, args[, options])`：
  - `options.stdin`：string，可选；省略时子进程读取到 EOF。
  - `options.timeoutMs`：正整数，默认 30000。
  - 结果表：`exitCode`、`stdout`、`stderr`、`stdoutTruncated`、`stderrTruncated`、`timedOut`；等待/读取失败时另有 `error`。
  - 启动失败返回 `nil, error`；非零退出仍返回结果表；信号终止时 `exitCode = -1`。
  - stdout/stderr 各保留开头 64 KiB；Linux 上超时/停止会杀死整个进程组。
  - 同步执行，只阻塞当前插件的 Lua goroutine；其他插件与宿主不受影响。
- `host.storage.*`：每插件 SQLite。
- `host.app.route`：精确 method + path，无路径参数；详情与操作统一用查询参数或 JSON body。
- `host.schedule.register`：用于证书探测等周期任务。
- `host.config.get/all`：读取 manifest 配置，热生效。
- `host.app.emit` / `/extensions/<id>/events`：v1 不使用，日志跟随由前端轮询。

插件为纯 Lua（Lua 与原生入口不能共存）。manifest 的 `minHostVersion` 为 `0.1.0`，对应包含 `host.process.exec`、`host.services` 与 `host.schedule` 能力的宿主版本。

## 4. 插件配置（manifest.config）

宿主仅支持 string/number/boolean，无枚举与文件选择；校验在 Lua 内完成。

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| Caddy 可执行文件 | string | `/opt/caddy/caddy` | 诊断存在性、可执行、版本 |
| 主 Caddyfile | string | `/opt/caddy/config/Caddyfile` | 诊断存在/可创建、可读写 |
| 站点片段目录 | string | `/opt/caddy/config/conf.d` | 插件确保存在且可写 |
| 站点根目录 | string | `/opt/caddy/sites` | 新建站点默认根；单站可覆盖 |
| 服务单元 | string | `caddy.service` | 原样传给 `host.services.*` |
| 日志轮询行数 | number | 500 | 100–2000 |
| 证书探测间隔（小时） | number | 6 | 1–168 |
| 备份保留数 | number | 100 | 10–1000 |

说明：

- 目录类配置用普通 string，不用 `format: writable-directory`：后者在安装/保存时创建并写测试，默认值指向 `/opt/caddy` 会导致开发环境安装失败。插件在首次使用与诊断页创建/校验目录。
- 配置热生效；修改根目录只影响之后创建的站点。
- 路径、邮箱等不提供插件自建设置页，统一在宿主的扩展配置表单中修改；插件诊断页只展示生效值。

## 5. 数据与文件

### 5.1 真源

- 配置文件是唯一真源。SQLite 只存 UI 元数据与表单快照缓存，不参与 Caddy 运行。
- 主 Caddyfile：
  ```caddyfile
  # >>> ext-caddy-manage:global
  {
  	email you@example.com
  	admin 127.0.0.1:2019
  	# 额外全局指令（表单中的原文）
  }
  # <<< ext-caddy-manage:global
  import conf.d/*.caddy
  ```
  表单只重写标记块内部；块外的注释与 `import` 行原样保留。额外全局指令只能写在受管块内（Caddyfile 只允许一个全局块）。标记缺失时全局表单禁用，原文编辑仍可用。
- 站点片段：`conf.d/<slug>.caddy`，由插件整体生成，允许手改；手改会触发漂移提示。
- 停用：文件移动到 `conf.d.disabled/<slug>.caddy`；启用移回。
- 删除站点：删除片段与元数据，保留站点目录。
- 手写片段（`conf.d` 中无元数据的 `*.caddy`）：在列表中显示为「自定义片段」，只提供原文编辑与启用/停用。

### 5.2 SQLite

```sql
CREATE TABLE IF NOT EXISTS sites (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  group_name  TEXT NOT NULL DEFAULT '默认',
  note        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL,              -- static | proxy | redirect
  model       TEXT NOT NULL,              -- 表单快照 JSON
  last_content TEXT NOT NULL,             -- 最近一次由插件写入的完整片段
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cert_cache (
  domain     TEXT PRIMARY KEY,
  issuer     TEXT NOT NULL DEFAULT '',
  not_after  TEXT NOT NULL DEFAULT '',    -- RFC3339 或空
  checked_at TEXT NOT NULL DEFAULT '',
  error      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`meta` 保存 `schema_version`、`global.model`、`global.last_content`。

漂移检测不使用哈希：读文件内容与 `last_content` 直接比较，精确且便于展示 diff。列表页可用 mtime+size 做快速提示，详情页做全文比较。

列表数据以文件系统为准，与 DB 元数据左连接：有文件无元数据 = 自定义片段；有元数据无文件 = 孤儿记录，可清理。

### 5.3 备份

- 位置：`<dataDir>/backups/`。
- 文件名：`<UTC 时间戳>--<原因>--<原文件名>`。
- 写入、停用、启用、删除、原文保存、恢复前均备份当前文件；主 Caddyfile 同样备份。
- 按配置保留最近 N 份，按文件名排序清理最旧。
- 恢复流程与普通写入相同：校验→写入→整体 validate→reload，失败回滚。

## 6. 站点模型

```json
{
  "name": "博客",
  "type": "static",
  "domains": ["example.com", "www.example.com"],
  "https": true,
  "group": "默认",
  "note": "",
  "static": {"root": "/opt/caddy/sites/blog", "browse": false, "spa": false},
  "proxy": {
    "upstreams": ["127.0.0.1:3000"],
    "lbPolicy": "round_robin",
    "health": {"enabled": true, "uri": "/health", "interval": "10s",
               "timeout": "3s", "status": 200},
    "skipVerify": false,
    "hostHeader": "",
    "dialTimeout": "5s",
    "responseHeaderTimeout": "30s"
  },
  "redirect": {"target": "https://new.example.com{uri}", "code": 301},
  "security": {
    "basicAuth": [{"user": "alice", "hash": "$2a$14$..."}],
    "ipMode": "off",
    "ipList": [],
    "headers": [{"name": "X-Content-Type-Options", "value": "nosniff"}],
    "hsts": false,
    "encode": true
  }
}
```

约束：

- `slug`：`[a-z0-9-]{1,64}`，创建时由名称或首个域名生成，全站唯一，创建后不可改。
- 站点地址：域名支持字母、数字、`-` 与 `.`。`127.0.0.1:<端口>` 和 `localhost:<端口>` 仅绑定 IPv4 回环地址。`0.0.0.0:<端口>` 绑定全部 IPv4 网卡，接受任意 Host。这三种地址均使用 HTTP。一个站点最多 20 个地址，同一个地址只能由一个站点使用。
- `basicAuth` 用户名 `[A-Za-z0-9._-]{1,64}`，最多 20 个；哈希只接受 `$2[abxy]$` bcrypt。
- 上游：`host:port`、`http://host:port`、`https://host:port`、`[v6]:port`；最多 20 个。Caddy 的 `reverse_proxy` 接受两种写法：全部上游都不带 scheme，或全部上游显式使用同一 scheme。混合写法对顺序敏感且可能改变 TLS 行为（例如全部不带 scheme 时 Caddy 按 HTTP 处理，即使端口是 443），插件拒绝混合，要求「全裸地址」或「同一显式 scheme」（实测 Caddy 2.10.2）。
- 响应头名称/值不得含换行；最多 20 个。
- 重定向目标必须是绝对 `http(s)` URL，可含 `{uri}`；状态码 301/302/307/308。
- 片段大小上限 48 KiB；原始主配置同样 48 KiB（`caddy fmt -` 输出受 64 KiB exec 上限约束）。
- 安全项只对 static/proxy 生效；重定向站点只保留域名、目标、状态码与日志。
- 响应头名称与值在生成时都加双引号。Caddy 词法器对以 `#`、反引号或纯花括号开头的裸 token 有特殊解释，引用可避免配置被误解析。

## 7. Caddyfile 生成

### 7.1 静态站

```caddyfile
# 由 ext-caddy-manage 生成；可在面板「配置文件」中编辑。
example.com, www.example.com {
	encode zstd gzip
	log
	root * /opt/caddy/sites/blog
	try_files {path} /index.html          # 仅 SPA 模式
	file_server browse                    # browse 可选
	basic_auth {                          # 可选
		alice $2a$14$...
	}
	@denied not remote_ip 10.0.0.0/8      # IP 允许模式示例
	respond @denied 403
	header {                              # 可选
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
	}
}
```

- HTTPS 关闭时站点地址写 `http://example.com`。
- IP 模式为 allow：`@denied not remote_ip <列表>`；为 deny：`@denied remote_ip <列表>`；`ipMode=off` 不生成。

### 7.2 反向代理

```caddyfile
app.example.com {
	encode zstd gzip
	log
	reverse_proxy 127.0.0.1:3000 127.0.0.1:3001 {
		lb_policy round_robin
		health_uri /health
		health_interval 10s
		health_timeout 3s
		health_status 200
		header_up Host example.internal          # 可选
		transport http {
			tls_insecure_skip_verify             # 仅 https 上游且启用时
			dial_timeout 5s
			response_header_timeout 30s
		}
	}
	# 安全片段同上
}
```

- WebSocket 由 Caddy 自动处理，不生成指令。
- `lb_policy` 始终写出，保证确定性；支持 `round_robin`、`least_conn`、`random`、`ip_hash`、`uri_hash`、`first`。
- 健康检查关闭时不写 `health_*`；状态码为单个整数。
- 无 TLS/超时配置时不写 `transport http` 块。

### 7.3 重定向

```caddyfile
old.example.com, www.old.example.com {
	log
	redir https://new.example.com{uri} 301
}
```

## 8. 变更流程

所有会改动配置的操作（创建、表单保存、原文保存、启用、停用、删除、恢复、全局保存）。站点写入前还必须确认主 Caddyfile 存在、可读，且包含覆盖站点片段目录的 `import` glob；否则返回 `not_initialized`，避免“保存成功但 Caddy 从未加载站点”。

1. 读取当前文件与 `last_content`。客户端提交它读取时的基线内容（或时间戳）；不一致则返回 `409 conflict` 与当前内容，UI 让用户选择「以磁盘为准」或「覆盖」。
2. 生成候选文本；校验站点模型与大小限制。
3. 片段先单独校验：
   ```sh
   caddy validate --config - --adapter caddyfile   # stdin = 候选片段
   ```
   失败则拒绝，不落盘。
4. 备份当前文件到 `backups/`。
5. 原子写入：同目录临时文件 + `os.rename`。
6. 整体校验：
   ```sh
   caddy validate --config <主 Caddyfile> --adapter caddyfile
   ```
   失败则恢复备份，返回校验错误（含文件与行号）。
7. 服务运行中才重载：
   ```sh
   caddy reload --config <主 Caddyfile> --adapter caddyfile
   ```
   失败则恢复备份，再 validate + reload 旧配置，返回原始错误与回滚结果；回滚也失败时返回 `rollback_failed` 与备份路径。
8. 成功后更新 `model`、`last_content`、`updated_at`，返回新内容与状态。

补充：

- 服务未运行时，写完并 validate 后跳过 reload，返回「已保存，服务未运行」。
- 主 Caddyfile 的保存同样走 4–8，不需要第 3 步。
- 启用/停用：移动文件后走整体 validate + reload；失败时移回。
- 删除：备份后删除片段，整体 validate + reload；失败则恢复。
- 全局保存只重写标记块，块外内容逐字节保留。
- 所有 `caddy` 调用都设置显式超时：validate 15s、reload 20s、fmt 10s、version 5s、list-modules 10s。

## 9. 服务与日志

### 9.1 服务

- 状态：`host.services.get(unit)`，展示 state、stateDetail、MainPID、ActiveEnterTimestamp。
- 启动/停止/重启：`host.services.start/stop/restart(unit, { sudo = true })`。
- 重载：先 `validate`，再 `caddy reload`（不是 `systemctl reload`，便于拿到错误输出）。
- 错误映射：
  - 启停、重启或查询返回 `permission` 时映射为 `privilege_missing`，分别提示检查系统 sudoers 或宿主账号的查询权限。
  - 日志返回 `permission` 或 `logs_unavailable` 时映射为 `journal_unavailable`，分别提示检查 `systemd-journal` 组权限或 `journalctl`。

### 9.2 日志

- 数据源：`host.services.logs(unit, lines)`；行格式 `TIMESTAMP HOST IDENT[PID]: MESSAGE`。
- 判定：截取 `]: ` 之后为 MESSAGE；以 `{` 开头且 JSON 解析成功、`logger == "http.log.access"` 的为访问日志；其余为服务日志。
- 站点日志：在窗口内按 `request.host` 匹配站点地址，忽略大小写，回环地址保留端口。监听所有 IPv4 网卡的站点通过独立的访问日志名称识别监听端口。解析 `method`、`uri`、`status`、`duration`、`remote_ip`、`user_agent`、`size`。
- 服务日志：展示非访问日志行；可切换「包含访问日志」。
- 过滤：关键字（子串）、状态码；站点页自动按域名过滤。
- 行数：`lines` 100–2000，默认取配置的 500。窗口是「整个 unit 最近 N 行」，高流量邻居可能把安静站点的旧行挤出窗口；「加载更多」拉满 2000 行，文档写明限制。
- 导出：返回 `text/plain`，最多当前窗口 2000 行，文件名带站点与时间。
- 实时跟随：前端在日志 tab 可见时每 1 秒轮询一次并重绘；暂停/继续/自动滚动。不使用服务端后台 tail，也不占插件 goroutine。
- 不在日志中输出密码、bcrypt 哈希以外的敏感数据；bcrypt 哈希本身按配置内容处理，不额外打日志。

## 10. 证书

- 只使用 Caddy 自动 HTTPS；每站点开关；HTTP→HTTPS 由 Caddy 在裸域名下自动处理。
- 全局设置：ACME 邮箱、staging CA 开关（写入受管全局块，显式警告）。
- 探测（缓存 TTL 取配置，默认 6 小时）：
  1. `openssl s_client -connect <domain>:443 -servername <domain> -showcerts`，stdin 省略（/dev/null），超时 8s。
  2. 从 stdout 取第一段 PEM。
  3. `openssl x509 -noout -subject -issuer -enddate`，stdin = PEM，超时 5s。
  4. 解析 `notAfter` 为 RFC3339，写入 `cert_cache`；失败记录错误文本。
- 触发：概览页「刷新证书」手动触发；`host.schedule` 每 6 小时探测过期缓存。探测串行执行；域名较多时会短暂占用插件 goroutine，可接受。
- 展示：域名、签发者、到期时间、剩余天数；≤14 天高亮。探测失败显示「未知」与错误摘要。
- 不读 `/var/lib/caddy`（Caddy 私有权限）；探测结果反映实际服务中的证书。
- 通配符域名在入口校验处直接拒绝并提示需要 DNS-01。

## 11. HTTP API

所有路由注册为精确 `METHOD + path`，统一前缀 `/api/`（宿主会剥掉 `/extensions/<id>/api`）。详情与操作使用查询参数或 JSON body。

响应约定：

```json
{"ok": true, "data": ...}
{"ok": false, "error": {"code": "conflict", "message": "...", "details": ...}}
```

HTTP 状态：200 成功，400 参数/模型错误，404 不存在，409 冲突，503 依赖不可用（Caddy/服务/系统权限/日志），500 内部错误。请求体上限 1 MiB，原始配置内容上限 48 KiB。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 轻量就绪检查 |
| GET | `/api/overview` | 服务状态、版本、站点计数、证书缓存、最近错误 |
| GET | `/api/sites` | 站点列表（文件系统 + DB） |
| GET | `/api/site?slug=` | 详情：模型、原文、漂移标记、最近备份 |
| POST | `/api/site` | 新建站点 |
| POST | `/api/site/update` | 表单保存 |
| POST | `/api/site/raw` | 原文保存片段 |
| POST | `/api/site/validate` | 校验候选片段（stdin） |
| POST | `/api/site/enable` | 启用 |
| POST | `/api/site/disable` | 停用 |
| POST | `/api/site/delete` | 删除（保留目录） |
| GET | `/api/global` | 主 Caddyfile 原文 + 受管块表单值 |
| POST | `/api/global` | 保存受管块 |
| POST | `/api/global/raw` | 保存主 Caddyfile 原文 |
| POST | `/api/config/validate` | 校验主配置：省略/`null` content 校验当前文件；字符串 content（含空串）写入同目录临时文件后按候选校验 |
| POST | `/api/config/fmt` | `caddy fmt -` 格式化候选文本 |
| POST | `/api/hash` | 生成 Basic Auth 的 bcrypt 哈希（密码只经 stdin 传给 `caddy hash-password`） |
| GET | `/api/service` | 服务详情 |
| POST | `/api/service/start` | 启动 |
| POST | `/api/service/stop` | 停止 |
| POST | `/api/service/restart` | 重启 |
| POST | `/api/service/reload` | validate + reload |
| GET | `/api/logs/service?lines=&q=` | 服务日志 |
| GET | `/api/logs/site?slug=&lines=&q=&status=` | 站点访问日志 |
| GET | `/api/logs/export?scope=&slug=&lines=` | 文本导出 |
| GET | `/api/certs` | 证书缓存 |
| POST | `/api/certs/refresh` | 立即探测过期项 |
| GET | `/api/backups` | 备份列表 |
| GET | `/api/backup?name=` | 备份内容 |
| POST | `/api/backup/restore` | 恢复并应用 |
| GET | `/api/diagnostics` | 诊断项 |
| POST | `/api/diagnostics/init` | 创建目录与初始 Caddyfile |

关键实现约束：

- `caddy hash-password`：`exec(caddy, {"hash-password"}, {stdin = password .. "\n", timeoutMs = 20000})`；不传 `--plaintext`；只接受 stdout 中的 `$2[abxy]$` 哈希；失败时不回显密码。
- `caddy fmt`：`exec(caddy, {"fmt", "-"}, {stdin = content, timeoutMs = 10000})`，返回格式化后的文本，不落盘。
- `caddy validate`（片段）：`exec(caddy, {"validate", "--config", "-", "--adapter", "caddyfile"}, {stdin = content, timeoutMs = 15000})`。
- `caddy validate`（整体）：`exec(caddy, {"validate", "--config", mainPath, "--adapter", "caddyfile"}, {timeoutMs = 15000})`；整体配置包含 `import`，必须用真实路径。
- `caddy reload`：`exec(caddy, {"reload", "--config", mainPath, "--adapter", "caddyfile"}, {timeoutMs = 20000})`。
- `caddy version` / `caddy list-modules`：stdout 上限 64 KiB；模块列表可能被截断，诊断页标注。
- `exec` 返回 `nil, err` 表示启动失败；非零退出检查 `exitCode`；`timedOut` 单独提示；截断时在诊断/错误信息中说明。
- 所有写操作串行（Lua 单 goroutine），不需要额外锁。

## 12. UI

无框架、无构建步骤，ES 模块 + `fetch`，哈希路由；主题、字号、间距、焦点、响应式断点遵循 `Extension-Host/docs/frontend-design.md` 与脚手架令牌；图标使用内联 SVG。

导航：概览 / 站点 / 全局配置 / 诊断。站点详情替换列表区域（列表-详情模式）。

- **概览**：服务卡片（状态、版本、启动时间、启动/停止/重启/重载）、站点计数、证书到期表、最近服务错误；服务日志抽屉。
- **站点列表**：搜索、类型/状态/分组筛选；列：状态、名称、域名、类型、分组、证书到期、更新时间、操作；批量启用/停用。空状态提供「新建站点」。
- **新建站点**：三步向导：类型 → 域名/根目录或上游/目标 → HTTPS 与分组备注。创建后进入详情。
- **站点详情**：
  - 头部：名称、域名、状态、保存并重载、启用/停用。
  - 基本：名称、分组、备注、域名、类型（创建后只读）、根目录/上游/目标。
  - HTTPS：开关、证书状态、staging 警告。
  - 反向代理（仅 proxy）：上游列表、策略、健康检查、超时、跳过校验、Host 头。
  - 安全（static/proxy）：Basic Auth 用户、压缩、响应头、HSTS、IP 模式与列表、目录浏览、SPA。
  - 日志：跟随、暂停、过滤、导出。
  - 配置文件：原文编辑（等宽字体）、校验、格式化、diff、保存；漂移横幅与「以磁盘为准 / 用表单覆盖」。
- **全局配置**：受管块表单（邮箱、staging、额外全局指令）+ 主配置原文编辑器 + 备份。
- **诊断**：二进制与版本、目录可写、Caddyfile 与标记、conf.d、站点根目录可读、unit 状态、journal 读取、sudo 提权说明、模块检测（l4/ratelimit/DNS）、整体 validate；「生成初始配置」按钮（已存在非空文件时需确认，绝不静默覆盖）。
- 所有破坏性操作二次确认，写明对象与后果；停用说明站点将停止服务；删除说明保留目录。
- 配置无效/未初始化时全站横幅，链接到诊断。
- 日志轮询只在对应 tab 可见时进行；切页停止。请求进行中禁用重复提交。

前端 API 基址：`new URL("../api/", document.baseURI)`（宿主把插件页面挂在 `/extensions/<id>/web/`）。

## 13. Lua 模块划分

```text
manifest.json
lua/
  init.lua       路由注册、启动钩子、定时任务注册
  api.lua        32 个 HTTP 路由的请求/响应编排
  util.lua       RFC3339/epoch、slug、JSON 数组标记等通用助手
  settings.lua   读取/校验 host.config，派生有效路径
  store.lua      SQLite 建表与迁移、站点元数据、证书缓存
  sites.lua      站点模型校验、slug/域名规则、Caddyfile 生成
  apply.lua      备份、原子写入、validate、reload、回滚、漂移
  caddy.lua      exec 封装：version/list-modules/validate/reload/fmt/hash-password
  services.lua   host.services 封装与错误映射
  logs.lua       journal 行解析、过滤、导出
  certs.lua      openssl 探测与缓存
  http.lua       JSON 解析、响应封装、错误码
  fs.lua         读写、备份、目录扫描、大小限制
web/
  index.html app.js api.js views/*.js components.js format.js style.css
deploy/
  caddy.service install.sh sudoers.example README.md
scripts/
  e2e.sh
```

无外部 Lua 依赖；`require` 只加载包内相对模块。

## 14. 测试

### 14.1 脚本化 e2e（无 root）

`scripts/e2e.sh`：

- 依赖：Go 工具链、curl、openssl；Caddy 二进制可下载（支持 `CADDY_TARBALL` 使用本地包）。
- 在临时目录解压 Caddy，生成临时配置目录与站点根目录；全局块写入 `admin 127.0.0.1:<高位端口>`、`http_port <高位端口>`、`https_port <高位端口>`。
- 手动启动 Caddy（非 systemd），用 `ext run` 启动宿主并安装插件、启用。初始化使用默认 Admin 端口 2019 的临时骨架；脚本需处理该端口被占用或连接挂起的情况。
- 覆盖：初始化 → 新建静态站 → 片段内容断言 → 片段与整体 validate → reload → HTTP 请求命中 → 表单修改 → 原文保存 → 冲突检测 → 停用/启用 → 删除 → 备份恢复 → fmt。
- 服务 start/stop/logs、证书探测与部署权限不在脚本内（需 systemd/真实域名），列入手工清单；脚本支持 `E2E_SYSTEMD=1` 时额外跑服务用例。

### 14.2 手工验收清单

- 安装/启用插件，由系统管理员配置 sudoers，启动/停止/重启/重载。
- journald 中按站点过滤访问日志，验证 1 秒轮询、暂停、导出。
- 真实域名自动 HTTPS、staging 切换、证书到期显示。
- Basic Auth 登录成功/失败；IP 允许/拒绝；HSTS 头。
- 外部手改片段后打开详情出现漂移提示；选择以磁盘为准/覆盖。
- 服务停止时保存配置只写文件不 reload。
- 删除站点后目录仍在。

## 15. 首期工单拆分

阶段 1：基础

1. manifest、配置读取/校验、诊断页与初始配置生成。
2. SQLite schema、文件系统扫描、站点列表与自定义片段展示。
3. `caddy.lua` exec 封装与错误映射（version/modules/validate/reload/fmt/hash）。
4. `apply.lua`：备份、原子写入、校验、reload、回滚、冲突检测。
5. 全局受管块表单 + 主配置原文编辑 + 格式化/校验/备份 UI。

阶段 2：站点

6. 静态站表单与生成（含 SPA、浏览、压缩）。
7. 反向代理表单与生成（上游、策略、健康检查、超时、Host、TLS 跳过校验）。
8. 重定向表单与生成。
9. 安全项：Basic Auth 哈希、响应头/HSTS、IP 列表。
10. 启用/停用/删除、漂移处理、备份恢复。

阶段 3：可观测

11. 服务控制与概览页。
12. 日志：服务/站点过滤、轮询跟随、导出。
13. 证书探测、缓存、staging 开关与概览展示。

阶段 4：交付

14. `deploy/` 产物与 README（unit、install.sh、sudoers 示例）。
15. `scripts/e2e.sh` 与手工验收清单。

## 16. 风险与已知限制

- 依赖宿主新能力：`host.process.exec`、`host.services.start/stop/logs`。必须用 `minHostVersion` 卡住，不能只靠 Host API 1。
- journald：宿主账号必须在 `systemd-journal` 组；unit 需关闭限流，否则高流量会丢日志。
- sudoers：宿主级规则必须与 `host.services` 的提权命令参数完全匹配，否则启停报 `permission`。
- 文件权限：`/opt/caddy/config` 与 `/opt/caddy/sites` 属宿主账号且对 `caddy` 用户可读；否则 Caddy 启动失败或站点 403。
- 单 goroutine：`exec`、证书探测会阻塞插件自身的其他请求；所有调用都有超时，前端显示进行中状态。
- 日志窗口：按站点过滤只能基于整个 unit 的最近 N 行，安静站点可能被高流量邻居挤出窗口。
- 证书：不读 Caddy 存储；探测依赖域名解析到本机且 443 可达，未上线域名会显示未知。
- 配置漂移：手改文件后必须以磁盘为准或覆盖，插件不会自动合并。
- Caddy 版本：`basic_auth`、`hash-password` stdin、`fmt -`、`validate --config -` 在 2.8 均可用；更低版本不支持。
- 上游协议：Caddy 的 `reverse_proxy` 接受「全部不带 scheme」或「全部显式同一 scheme」；插件拒绝混合写法。
- 符号链接：配置目录可以是符号链接（stat/find 跟随）；配置文件本身是符号链接时允许读取，但写入、移动、删除会拒绝并报错，避免替换链接或误删目标。
- 不支持通配符/DNS-01、L4、限流、PHP、手动证书。


## 17. 实现备注

- 实际模块比 §13 多出 `lua/api.lua`（HTTP 路由编排）与 `lua/util.lua`（时间、slug、JSON 数组标记等助手）。
- 新增 `POST /api/hash`，供站点表单调用 `caddy hash-password` 生成 bcrypt 哈希。
- 站点写入（含新建、表单/原文保存、启用）在落盘前检查主 Caddyfile 存在、可读，并含覆盖片段目录的 `import` glob；缺失时返回 `not_initialized`，健康检查和诊断页也会提示。
- 初始化成功后写入 `global.last_content` / `global.model`，使首次安装后的全局漂移检测立即生效。
- 生成 Caddyfile 时响应头名称和值都加双引号；纯 `{`/`}` 响应头值被拒绝。
- 上游只允许「全部不带 scheme」或「全部显式同一 scheme」；混合写法在模型校验阶段拒绝。
- IPv6 上游与 IP 列表做完整的结构校验，避免 Caddy adapt 阶段不拒绝、运行时才失败。
- 配置目录可以是被跟随的符号链接；配置文件本身是符号链接时读取可用，写入/移动/删除会拒绝。
- 服务状态未知时，先用 openssl 探测受管 admin 端点；不可达则保存但不重载，可达才执行 reload 并保留失败回滚。
- 前端全站横幅覆盖未初始化、缺少受管标记、片段目录未导入三种状态；站点/全局表单在请求期间禁用输入，原文保存前会确认未保存的表单修改。
