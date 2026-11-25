# ext-caddy-manage

自托管的 Caddy 运维面板，作为 Extension Host / GoDesk 插件运行。插件 id 为 `cn.ezios.ecm`，提供轻量的「站点」抽象：在保留 Caddyfile 原文控制力的同时，用表单管理静态站、反向代理、重定向，以及服务状态、日志、证书到期与配置安全网。

- 纯 Lua 后端（gopher-lua / Lua 5.1），无外部 Lua 依赖；运行依赖 Caddy、`openssl`、`curl` 与 findutils/coreutils。Linux 上的监听、解析和访问日志检查分别使用 `ss`、`getent` 和 `journalctl`。前端为无构建步骤的 ES 模块。
- 配置文件（Caddyfile + `conf.d/*.caddy`）是唯一真源；SQLite 只存 UI 元数据与表单快照。
- 所有写操作串行：片段校验 → 备份 → 原子写入 → 整体校验 → 热重载，失败自动回滚。
- 站点写入前会检查主 Caddyfile 是否导入片段目录；未导入时拒绝写入并在页面顶部与诊断页提示。
- 完整设计见 [`docs/design.md`](docs/design.md)；部署手册见 [`deploy/README.md`](deploy/README.md)。

## 功能

- **服务**：Caddy 版本、systemd 状态、启动/停止/重启；重载先 `validate` 再 `caddy reload`，错误直接展示。
- **配置**：主 Caddyfile 的受管全局块（ACME 邮箱、staging、额外全局指令）+ 原文编辑；站点片段表单与原文并存；格式化、校验、冲突检测、漂移提示。
- **站点**：静态站（根目录、目录浏览、SPA 回退）、反向代理（多上游、负载均衡策略、健康检查、Host 头、TLS 跳过校验、超时）、重定向；多域名、启用/停用、分组与备注、自定义手写片段识别。
- **安全**：Basic Auth（bcrypt）、压缩、HSTS 与自定义响应头、IP 允许/拒绝。
- **日志**：服务日志与按站点域名过滤的访问日志，前端轮询跟随、过滤、导出。
- **证书**：Caddy 自动 HTTPS；staging 开关；openssl 探测签发者与到期时间并缓存。
- **安全网**：写入前备份、可配置保留数、原子写入、reload 失败回滚、外部修改检测、备份恢复走同一校验流程。

V0.2 的新站点需要选择监听范围。访问地址可填域名、IPv4 或 IPv6。选择「内网 HTTPS」时，站点详情提供本机入口检测和运行实例的公开根 CA。反向代理站点可在「流量去向」中配置路径规则与兜底。DNS-01 的模块检测与部署步骤见 [部署手册](deploy/README.md#dns-01)。

V0.3 在「新建站点」中提供本机服务、手填上游、静态目录和重定向四个入口。普通 Web 支持 WebSocket 和 SSE，SPA + API 使用路径路由，文件下载预设会开启目录浏览。发布前设置访问范围和访问控制，在所有接口发布时须单独确认。发布结果显示配置保存、Caddy 加载及宿主对首个访问 URL 的入口验证，可重试加载或验证。

本机发现使用宿主账号执行 `ss`（iproute2），只在主动操作时读取可见的 TCP 监听。进程或 systemd 单元不可见时仍可选取监听。选中后以 `curl` 向监听地址发起一次有时限的 HTTP 根路径请求，只展示结果和状态码。应用尚未就绪时仍可发布。缺少 `ss` 或发现结果不可用时可手填上游，HTTPS 上游也通过手填设置。

### V0.4 运行诊断

- 概览的「采集运行快照」读取受管 Caddy 的本机 Admin `/metrics`，支持回环地址和 Unix socket。可在全局配置的额外全局指令中加入 `metrics` 开启 HTTP 处理器指标，并保持 `per_host` 关闭。运行指标或上游样本可能在没有 HTTP 样本时仍可读取。处理次数按 Caddy 的 server 和 handler 分组，HTTP 5xx 与中间件错误独立展示。Caddy 报告可选的上游需要单独确认连通。
- 采集用 64 KiB 的读取上限和 2 秒的传输上限。实例内共用快照，10 秒内重复采集复用结果，90 秒后标记过期。打开概览读取缓存。要启用自动采集，在宿主扩展配置里将 `metricsPeriodic` 设为 `true`，然后打开概览或重新启动插件。此后插件每 60 秒采集一次，离开概览也会继续。
- 站点访问摘要与下方日志使用同一个 Journal 窗口。摘要显示当前可见时间、匹配请求、4xx、5xx 和平均响应耗时。点击状态分类筛选下方日志。窗口最多读取所选行数及 64 KiB，优先计算最新完整行，同一窗口在 4 秒内共享。文件和不受支持的日志格式不计入摘要。
- 站点详情的「检查站点」会带入站点，可选择已配置的访问入口。检查从宿主执行，先判断磁盘配置是否适合主动探测，再展示 DNS、监听归属、TLS/SNI/信任、上游和 HTTP 响应。入口 `HEAD /` 探测连接本机监听，保留原域名或 IP 身份。上游对最多三个配置目标执行 `HEAD /` 并报告覆盖情况。进程归属对宿主不可见时显示未知。检查可跳到配置或证书信任指引。

## 架构

```text
manifest.json           插件清单（id、版本、配置 schema、能力）
lua/
  init.lua              路由注册、启动钩子
  api.lua               插件 HTTP 路由的编排
  settings.lua          manifest 配置读取、校验、默认值
  sites.lua             站点模型校验、slug/域名规则、Caddyfile 生成
  apply.lua             备份、原子写入、校验、reload、回滚、全局块拼接
  util.lua              RFC3339/epoch、slug、JSON 数组标记等通用助手
  caddy.lua             caddy exec 封装（version/modules/validate/reload/fmt/hash-password）
  fs.lua                文件读写、目录扫描、备份
  store.lua             SQLite schema 与元数据
  services.lua          host.services 封装与错误映射
  metrics.lua           本机 Caddy Metrics 读取与共享快照
  sitecheck.lua         已配置站点的宿主链路检查
  discovery.lua         本机监听发现、探测与发布前复核
  logs.lua              journald 行解析、过滤、导出
  certs.lua             openssl 探测与缓存
  http.lua              JSON 请求/响应与错误码
web/                    无构建前端（ES 模块、哈希路由）
deploy/                 caddy.service、install.sh、sudoers 示例、部署手册
scripts/e2e.sh          针对真实宿主的端到端脚本
docs/design.md          设计文档
```

核心约定：

- 全局配置写在主 Caddyfile 的 `# >>> ext-caddy-manage:global` 与 `# <<< ext-caddy-manage:global` 之间，块外字节原样保留；缺少标记时全局表单禁用，原文编辑仍可用。
- 站点片段为 `conf.d/<slug>.caddy`，停用时移动到 `conf.d.disabled/`；删除站点只删片段与元数据，保留站点目录。
- 列表以文件系统为准并与数据库左连接：有文件无元数据 = 自定义片段；有元数据无文件 = 孤儿记录。
- 插件路由的 JSON 响应为 `{"ok":true,"data":...}` 或 `{"ok":false,"error":{"code","message","details"}}`；宿主自身的错误（插件未启用、路由不存在、方法不允许）使用宿主格式 `{"error":"..."}`。

## 开发与打包

前置：Go 工具链（构建宿主）、Caddy ≥ 2.8（用于本地联调）、支持 `host.services` 的 `sudo` 选项的 Extension Host（宿主源码当前版本为 0.3.0）；前端无构建步骤，不需要 Node。

在仓库根目录：

| 命令 | 用途 |
| --- | --- |
| `ext dev` | 自动安装并启用当前插件；保存文件后更新，数据在 `.ext/` |
| `ext pkg` | 生成 `dist/cn.ezios.ecm-0.4.0.zip`，可在 `/host/` 或 GoDesk「扩展」中安装 |

从源码构建宿主并运行（`../Extension-Host`）：

```sh
(cd ../Extension-Host && GOWORK=off CGO_ENABLED=0 go build -o bin/ext ./cmd/ext)
../Extension-Host/bin/ext run . --data-dir /tmp/ecm-data --listen 127.0.0.1:5001
```

`ext pkg` 只打包 `manifest.json`、`web/`、`lua/` 和 `native/`；`deploy/`、`scripts/`、`docs/` 不进入 ZIP，部署时从仓库目录使用。

## 配置

宿主扩展配置表单中的键与默认值（保存后热生效，无需重启插件）。目录类配置是普通字符串，首次使用或诊断页“生成初始配置”时创建。

| 键 | 类型 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `caddyBinary` | string | `/opt/caddy/caddy` | 绝对路径 | Caddy 可执行文件 |
| `mainConfig` | string | `/opt/caddy/config/Caddyfile` | 绝对路径 | 主 Caddyfile |
| `snippetDir` | string | `/opt/caddy/config/conf.d` | 绝对路径 | 启用的站点片段目录；停用目录为 `<dir>.disabled` |
| `sitesRoot` | string | `/opt/caddy/sites` | 绝对路径 | 新建静态站的默认根目录 |
| `serviceUnit` | string | `caddy.service` | `*.service` | 传给 `host.services.*` 的单元 |
| `logLines` | number | 500 | 100–2000 | 日志默认行数 |
| `certProbeHours` | number | 6 | 1–168 | 证书探测缓存 TTL |
| `backupKeep` | number | 100 | 10–1000 | 备份保留数量 |
| `metricsPeriodic` | boolean | false | true / false | 启用后每 60 秒采集 Caddy 运行快照 |

路径必须是宿主机绝对路径；非法值会回退默认值并在诊断页提示。修改 `sitesRoot` 只影响之后创建的站点。

## 部署

生产部署（Ubuntu 24.04+ / systemd）分两步：系统层准备与插件安装。

```sh
# 1) 系统层：Caddy 二进制、caddy 账号、/opt/caddy 目录、unit
sudo ./deploy/install.sh --host-user godesk

# 2) 剩余的宿主侧步骤（install.sh 会打印）：
sudo systemctl enable --now caddy.service
sudo usermod -aG systemd-journal godesk             # 重新登录后生效
# 非 root 宿主的启停与重启权限由系统管理员配置，参见部署手册
ext pkg                                             # 在 /host/ 安装并启用 ZIP
```

安装脚本幂等，永不覆盖已有 Caddyfile。完整的账号、权限、journald、sudoers、验证、升级与故障排查见 **[deploy/README.md](deploy/README.md)**。

关键前提：

- Caddy 官方静态二进制安装在 `/opt/caddy/caddy`（root:root 0755），不用 apt 包。
- `/opt/caddy/config` 与 `/opt/caddy/sites` 属宿主账号、0755；配置 0644，Caddy 只读。
- 查询服务与读取日志使用宿主账号。日志读取需要 `systemd-journal` 组权限。
- 启动、停止和重启请求 `{ sudo = true }`。非 root 宿主的 sudoers 规则由系统管理员配置。

## HTTP API 概览

所有路由挂在 `/extensions/cn.ezios.ecm/api` 下，方法 + 路径精确匹配；JSON 请求体上限 1 MiB，配置文本上限 48 KiB。

| 分组 | 路由 |
| --- | --- |
| 健康/概览 | `GET /health`、`GET /overview`、`GET /metrics`（缓存）、`POST /metrics`（按需采集）、`GET /diagnostics`、`POST /diagnostics/init` |
| 站点 | `GET /sites`、`GET /site?slug=`、`POST /site`、`POST /site/update`、`POST /site/raw`、`POST /site/validate`、`POST /site/check`（`slug`、可选 `index`）、`POST /site/enable`、`POST /site/disable`、`POST /site/delete` |
| 全局配置 | `GET /global`、`POST /global`、`POST /global/raw`、`POST /config/validate`、`POST /config/fmt`、`POST /hash` |
| 服务 | `GET /service`、`POST /service/start`、`POST /service/stop`、`POST /service/restart`、`POST /service/reload` |
| 日志 | `GET /logs/service`、`GET /logs/site`（可用 `status=503` 或 `statusClass=5` 过滤原始记录）、`GET /logs/export` |
| 证书 | `GET /certs`、`POST /certs/refresh` |
| 备份 | `GET /backups`、`GET /backup?name=`、`POST /backup/restore` |

错误码：`bad_request` 400、`invalid_json` 400、`invalid_model` 400、`size_limit` 400、`validate_failed` 400、`not_found` 404、`conflict` 409、`markers_missing` 409、`not_running` 409、`not_initialized` 503、`caddy_missing` 503、`privilege_missing` 503、`journal_unavailable` 503、`service_error` 503、`reload_failed` 503、`rollback_failed` 500、`internal` 500。详见 `docs/design.md` §11 与 `lua/` 中的实现。

## 测试

端到端脚本针对真实宿主与真实 Caddy 二进制运行，不需要 root，也不需要 systemd：

```sh
bash scripts/e2e.sh
```

依赖：Go 工具链、curl、python3、tar；默认从 GitHub Release 下载 Caddy 2.10.2。可用环境变量覆盖：

| 变量 | 说明 |
| --- | --- |
| `EXT_SOURCE` | Extension Host 源码目录，默认 `../Extension-Host` |
| `CADDY_VERSION` | 下载的 Caddy 版本，默认 `2.10.2` |
| `CADDY_TARBALL` | 使用本地 Caddy 发布包（`caddy_<版本>_linux_<架构>.tar.gz`） |
| `CADDY_BIN` | 直接使用已有 Caddy 二进制 |
| `E2E_SYSTEMD=1` | 额外读取 `caddy.service` 状态（需要 systemd 与已安装的 unit） |
| `E2E_KEEP=1` | 保留临时目录与日志，便于排查 |

覆盖流程：初始化与健康检查 → 新建静态站（HTTPS 关闭）→ 片段内容断言 → 片段与整体 validate → reload → 带 Host 头的 HTTP 请求命中 → 表单修改 → 原文保存 → 冲突 409 → 停用/启用 → 删除（站点目录保留）→ 备份恢复 → `caddy fmt`。脚本在临时目录构建宿主、下载 Caddy、用 python3 选择空闲端口，退出时清理进程与目录。

注意：如果默认 Admin 端口 `2019` 空闲，脚本会临时占用它验证默认初始化。检测到该端口已被使用时，脚本使用隔离的预置配置继续测试。`E2E_SYSTEMD=1` 的 systemd 读取检查需要已安装的 `caddy.service` 和宿主账号的读取权限。

使用标准 Caddy 和独立 Extension Host 验收两个版本的 ZIP：

```bash
python3 scripts/e2e-v02.py --caddy /opt/caddy/caddy \
  --previous-zip /path/to/cn.ezios.ecm-0.1.0.zip \
  --current-zip dist/cn.ezios.ecm-0.2.0.zip
```

该脚本使用高位测试端口，覆盖 V0.1 升级、非默认设置恢复、备份保留、内网 TLS、路径路由和重载失败回滚。可传入 `--host` 指定宿主二进制，或传入 `--serve` 保留测试实例以检查界面。

```bash
ext pkg
python3 scripts/e2e-v03.py --caddy /opt/caddy/caddy \
  --previous-zip dist/cn.ezios.ecm-0.2.0.zip \
  --current-zip dist/cn.ezios.ecm-0.3.0.zip
```

V0.3 脚本验证 V0.2 升级、按需发现、IPv4/IPv6、监听变化、手填回退、各发布预设、WebSocket、SSE 和保存、加载、验证的状态。验收环境需要可用的 `ss`、`curl` 和 IPv6 回环。

```bash
python3 scripts/e2e-v04.py --caddy /opt/caddy/caddy \
  --previous-zip dist/cn.ezios.ecm-0.3.0.zip \
  --current-zip dist/cn.ezios.ecm-0.4.0.zip --resources
```

V0.4 脚本覆盖 V0.3 升级、快照状态、配置回滚、窗口和诊断故障。访问日志用独立 Caddy 生成的记录校验格式，并以可控的 Journal 输出验证权限、空窗口和截断。使用 `--resources` 实测过期、60 秒周期、API 响应与 Host/Caddy RSS。浏览器验收可单独使用 `--serve` 保留实例。

需要真实域名、systemd 或证书的手工验收清单（服务启停、staging、Basic Auth、IP 规则、漂移处理、证书到期）见 `docs/design.md` §14.2。

## 已知限制

- 界面不支持 TCP/UDP 四层代理、限流、DNS-01 表单或手动上传证书。
- Caddy 的 `reverse_proxy` 要求上游「全部不带 scheme」或「全部显式同一 scheme」；插件拒绝混合写法。
- 配置文件本身是符号链接时只允许读取；写入/移动/删除会拒绝并报错，请直接配置真实路径（配置目录可以是指向目录的符号链接）。
- 不支持 FastCGI/PHP、文件管理、容器、多用户/RBAC、访问历史与长期统计、站点重命名、多 Caddy 实例。
- 站点日志基于整个 unit 的最近 N 行；高流量邻居可能把安静站点的旧行挤出窗口。
- 证书探测依赖域名解析到本机且 443 可达；未上线域名显示“未知”。
- 配置漂移不会自动合并，必须选择“以磁盘为准”或“用表单覆盖”。
- Lua 单 goroutine：`exec` 与证书探测会短暂阻塞插件自身的其他请求，所有调用都有显式超时。
- Caddy 版本要求 ≥ 2.8（`basic_auth`、`hash-password` stdin、`fmt -`、`validate --config -`）。

## 安全说明

- 独立宿主默认只监听回环地址且没有登录；不要直接暴露到公网，远程访问请放在带认证的反向代理后。
- 插件只通过 Host API 执行操作。sudoers 仅允许宿主账号以 root 执行 `caddy.service` 的 start/stop/restart 三条完整命令。
- Caddy 以专用 `caddy` 账号运行，配置文件与站点目录对它是只读的（0755/0644）。
- 写入使用同目录临时文件 + `os.rename`；每次改动先备份，整体校验失败或 reload 失败会回滚并报告备份。
- 插件不会在日志中输出密码、明文哈希输入或完整模型；Basic Auth 的 bcrypt 哈希会出现在站点片段、站点模型快照（SQLite）与备份中，应按敏感配置保护。
- 备份目录位于宿主插件数据目录，权限 0700；备份文件 0600。
