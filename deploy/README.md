# ext-caddy-manage 部署与运维手册

本手册面向部署 Extension Host（或 GoDesk）与 Caddy 的运维者，说明如何准备系统账号、目录权限、systemd、journald、服务授权与 sudoers，以及如何安装、配置、验证和升级本插件。

插件 id 为 `cn.ezios.ecm`，最低 Extension Host 版本 0.3.0。插件本身不安装 systemd unit、不写 sudoers、不改系统账号；这些由 `deploy/` 中的产物和 `install.sh` 完成。

## 1. 部署拓扑

```text
浏览器 ──> Extension Host（宿主账号，如 godesk）
              │  └─ 插件 cn.ezios.ecm（纯 Lua）
              │       ├─ host.process.exec ──> /opt/caddy/caddy
              │       │     version / list-modules / validate / reload / fmt / hash-password
              │       └─ host.services ──> systemctl（经 grants + sudoers 提权）
              │                          └─ journalctl（宿主账号读日志）
              └─ 配置文件写入 ──> /opt/caddy/config（属宿主账号，0644）
Caddy（caddy 账号）── 只读 /opt/caddy/config 与 /opt/caddy/sites
```

关键点：

- 配置的文件系统是唯一真源；插件只写 `/opt/caddy/config` 下的文件。
- 校验、格式化、热重载都直接调用 `/opt/caddy/caddy`，不需要提权；`caddy reload` 通过本机 Admin API `127.0.0.1:2019`。
- 启动/停止/重启 systemd 单元才需要宿主级 sudoers 规则；插件从不执行 `sudo` 或 `systemctl`。
- Caddy 以专用 `caddy` 账号运行，对配置与站点目录只有读权限。

## 2. 前置条件

- Ubuntu 24.04 或更新版本，systemd，amd64 或 arm64。
- 运行 Extension Host 的账号已存在（示例使用 `godesk`），并且是未来写入配置的属主。
- Caddy 使用官方 GitHub Release 的静态二进制，版本 ≥ 2.8（推荐 2.10.x），安装到 `/opt/caddy/caddy`，不使用 apt 包。
- 宿主账号可执行 `sudo`（非 root 运行时）；80/443 端口空闲。
- Extension Host ≥ 0.3.0（包含 `host.process.exec` 与 `host.services` 的 start/stop/restart/logs）。
- 插件包不包含 `deploy/` 与 `scripts/`（`ext pkg` 只打包 `manifest.json`、`web/`、`lua/`、`native/`），部署产物需要在仓库目录中执行。

## 3. 快速安装

在仓库根目录执行：

```sh
sudo ./deploy/install.sh --host-user godesk
```

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--caddy-version <版本>` | 从 GitHub Release 下载指定版本，默认 `2.10.2` |
| `--tarball <文件>` | 使用本地 `caddy_<版本>_linux_<架构>.tar.gz`，跳过下载；需同时指定 `--allow-unverified` |
| `--host-user <账号>` | 运行 Extension Host 的账号，默认 `godesk` |
| `--host-group <组>` | 宿主账号的组，默认取该账号主组 |
| `--no-sudoers` | 不写 `/etc/sudoers.d/ext-caddy-manage` |
| `--allow-unverified` | 允许使用无法校验的本地 tarball，或在 checksums.txt 不可用时继续（不推荐） |
| `-h`, `--help` | 显示帮助 |

脚本做的事：

1. 校验 root、宿主账号/组、CPU 架构与版本格式。
2. 下载 Caddy 发布包并强制校验 SHA-512（校验失败或 checksums.txt 不可用时中止，除非显式 `--allow-unverified`）；本地 `--tarball` 必须显式 `--allow-unverified` 并会提示未校验。校验通过后安装为 `/opt/caddy/caddy`，root:root 0755。已安装相同版本时跳过下载。
3. 若不存在则创建系统组/账号 `caddy`（home `/var/lib/caddy`，shell `nologin`），并创建 `/var/lib/caddy`（caddy:caddy 0750）。
4. 创建 `/opt/caddy`（root:root 0755）、`/opt/caddy/config`、`config/conf.d`、`config/conf.d.disabled`、`/opt/caddy/sites`（宿主账号 0755）。
5. **仅当 `/opt/caddy/config/Caddyfile` 不存在时**写入初始受管 Caddyfile；已存在则原样保留。
6. 安装 `/etc/systemd/system/caddy.service`（内容变化时 daemon-reload），但不会启动或启用服务。
7. 生成并校验 `/etc/sudoers.d/ext-caddy-manage`（0440），规则只允许宿主账号以 root 执行 `caddy.service` 的 `start`、`stop`、`restart`。已存在且内容相同时跳过。
8. 打印后续步骤：启动服务、journal 组、服务授权、安装插件、配置项。

脚本可重复执行；不会覆盖已有主 Caddyfile、不会改动现有站点片段、不会输出任何密钥。

安装完成后仍需手工执行第 6–11 节的步骤。

## 4. 手动安装（不使用 install.sh）

```sh
# 1) 系统账号
sudo groupadd --system caddy
sudo useradd --system --gid caddy --home-dir /var/lib/caddy \
  --shell /usr/sbin/nologin --comment "Caddy web server" caddy
sudo install -d -o caddy -g caddy -m 0750 /var/lib/caddy

# 2) Caddy 二进制（以 2.10.2 amd64 为例）
curl -fL -o /tmp/caddy.tar.gz \
  https://github.com/caddyserver/caddy/releases/download/v2.10.2/caddy_2.10.2_linux_amd64.tar.gz
# 建议先按同版本 release 的 checksums.txt 做 SHA-512 校验：
# curl -fL -o /tmp/caddy_checksums.txt \
#   https://github.com/caddyserver/caddy/releases/download/v2.10.2/caddy_2.10.2_checksums.txt
# (cd /tmp && grep ' caddy_2.10.2_linux_amd64.tar.gz$' caddy_checksums.txt | sha512sum -c -)
tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
sudo install -d -o root -g root -m 0755 /opt/caddy
sudo install -o root -g root -m 0755 /tmp/caddy /opt/caddy/caddy

# 3) 目录（HOST_USER 替换为宿主账号，组名按该账号主组调整）
HOST_USER=godesk
sudo install -d -o root -g root -m 0755 /opt/caddy
sudo install -d -o "$HOST_USER" -g "$HOST_USER" -m 0755 \
  /opt/caddy/config /opt/caddy/config/conf.d /opt/caddy/config/conf.d.disabled /opt/caddy/sites

# 4) 初始 Caddyfile（注意使用 Tab 缩进；文件不存在时才创建）
if [ ! -e /opt/caddy/config/Caddyfile ]; then
sudo tee /opt/caddy/config/Caddyfile >/dev/null <<'EOF'
# >>> ext-caddy-manage:global
{
	admin 127.0.0.1:2019
}
# <<< ext-caddy-manage:global
import conf.d/*.caddy
EOF
sudo chown "$HOST_USER":"$HOST_USER" /opt/caddy/config/Caddyfile
sudo chmod 0644 /opt/caddy/config/Caddyfile
fi

# 5) systemd unit 与 sudoers
sudo install -o root -g root -m 0644 deploy/caddy.service /etc/systemd/system/caddy.service
sudo systemctl daemon-reload
sudo sed 's/^godesk /'"$HOST_USER"' /' deploy/sudoers.example > /tmp/ext-caddy-manage.sudoers
sudo visudo -cf /tmp/ext-caddy-manage.sudoers
sudo install -o root -g root -m 0440 /tmp/ext-caddy-manage.sudoers /etc/sudoers.d/ext-caddy-manage
```

## 5. 文件与权限

| 路径 | 属主 | 权限 | 说明 |
| --- | --- | --- | --- |
| `/opt/caddy` | root:root | 0755 | 安装根目录 |
| `/opt/caddy/caddy` | root:root | 0755 | 官方静态二进制 |
| `/opt/caddy/config` | 宿主账号 | 0755 | 插件写配置；caddy 用户可读 |
| `/opt/caddy/config/Caddyfile` | 宿主账号 | 0644 | 主配置，含受管全局块 |
| `/opt/caddy/config/conf.d` | 宿主账号 | 0755 | 启用的站点片段 |
| `/opt/caddy/config/conf.d.disabled` | 宿主账号 | 0755 | 停用的站点片段 |
| `/opt/caddy/sites` | 宿主账号 | 0755 | 站点根目录，caddy 用户可读 |
| `/var/lib/caddy` | caddy:caddy | 0750 | Caddy 私有状态，插件不读 |
| `/etc/systemd/system/caddy.service` | root:root | 0644 | systemd unit |
| `/etc/sudoers.d/ext-caddy-manage` | root:root | 0440 | 提权规则 |
| `<宿主 data-dir>/plugins/cn.ezios.ecm/data` | 宿主账号 | 0700 | 插件数据目录（宿主创建） |
| `<data>/backups` | 宿主账号 | 0700 | 备份，文件 0600 |

权限原则：

- 配置与站点属宿主账号，Caddy 只读，防止 Caddy 账号修改配置。
- 目录 0755、配置 0644，保证 `caddy` 用户可进入并读取；否则站点会 403 或 Caddy 启动失败。
- 不要在 `/opt/caddy` 上放宽写权限给 `caddy` 或其他账号。
- 每个站点根目录默认是 `/opt/caddy/sites/<slug>`，由运维自行放入静态文件；插件不会创建或删除站点目录内容。
- 配置目录可以是指向目录的符号链接（读取时跟随）；配置文件本身若是符号链接，插件只读取，写入/移动/删除会拒绝并报错，请直接配置真实文件路径。

## 6. systemd 服务

unit 关键项：

- `User=caddy` / `Group=caddy`；`ExecStart` 读取 `/opt/caddy/config/Caddyfile`。
- `AmbientCapabilities=CAP_NET_BIND_SERVICE` 允许非 root 绑定 80/443。
- `Restart=on-failure`、`LimitNOFILE=1048576`。
- `LogRateLimitBurst=0` 关闭 journald 限流，避免高流量时丢弃访问日志。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now caddy.service
sudo systemctl status caddy.service --no-pager
sudo journalctl -u caddy.service -n 50 --no-pager
```

插件中的“重载”按钮执行 `caddy validate` + `caddy reload`（不是 `systemctl reload`），这样可以拿到具体错误并回滚。只有启动/停止/重启走 systemd。

## 7. journald 日志权限

`host.services.logs` 以宿主账号执行 `journalctl`，宿主账号必须属于 `systemd-journal` 组：

```sh
sudo usermod -aG systemd-journal godesk
# 重新登录该账号（或重启宿主进程）后生效
id godesk
journalctl -u caddy.service -n 5 --no-pager
```

未加入时，插件日志页会提示“宿主账号需加入 systemd-journal 组”（`journal_unavailable`）。

限制：日志窗口是整个 unit 的最近 N 行（100–2000，默认取插件配置 `logLines`）。高流量邻居可能把安静站点的旧访问日志挤出窗口；这不是插件能控制的。导出只导出当前窗口内容。

## 8. 服务授权（grants）

使用服务能力需要同时满足：

1. Manifest 声明 `services` 能力（本插件已声明）。
2. 宿主启动时通过授权文件为本插件配置 `cn.ezios.ecm`。

把 `deploy/grants.example.json` 合并到宿主使用的授权文件（与现有插件共存，不要整文件覆盖）：

```json
{
  "cn.ezios.ecm": {
    "units": ["caddy.service"],
    "actions": ["list", "get", "start", "stop", "restart", "logs"],
    "elevate": ["start", "stop", "restart"]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `units` | 允许访问的单元；必须是合法 `.service` 名 |
| `actions` | `list`、`get`、`start`、`stop`、`restart`、`logs` |
| `elevate` | 仅 `start`、`stop`、`restart`；必须同时出现在 `actions` 中 |

传递方式：

- 独立宿主：`ext serve --service-grants /etc/extension-host/service-grants.json`（示例路径，按实际部署填写）
- 开发/单插件：`ext run <包目录或 ZIP> --service-grants <文件> --data-dir <目录>`
- GoDesk：通过 `--extension-grants` 传入同一份文件

修改授权文件后必须重启宿主。未授权时插件返回 `grant_missing`，提示“部署授权文件未包含该单元/操作”。

## 9. sudoers 提权

宿主以非 root 运行时，`elevate` 中的操作通过以下形式执行：

```sh
sudo -n -k -u root -- /usr/bin/systemctl start --no-ask-password -- caddy.service
# stop / restart 同理
```

因此 sudoers 规则必须逐字匹配命令、参数顺序、`--` 与单元名。`deploy/sudoers.example` 提供完整规则：

```sudoers
Cmnd_Alias CADDY_SERVICE = \
  /usr/bin/systemctl start --no-ask-password -- caddy.service, \
  /usr/bin/systemctl stop --no-ask-password -- caddy.service, \
  /usr/bin/systemctl restart --no-ask-password -- caddy.service

godesk ALL=(root) NOPASSWD: CADDY_SERVICE
```

安装与校验（将 `godesk` 换成实际宿主账号）：

```sh
sed 's/^godesk /<宿主账号> /' deploy/sudoers.example > /tmp/ext-caddy-manage.sudoers
sudo visudo -cf /tmp/ext-caddy-manage.sudoers
sudo install -o root -g root -m 0440 /tmp/ext-caddy-manage.sudoers /etc/sudoers.d/ext-caddy-manage
rm -f /tmp/ext-caddy-manage.sudoers
```

验证（会真正启动服务）：

```sh
sudo -n -k -u root -- /usr/bin/systemctl start --no-ask-password -- caddy.service
```

注意：

- 将 `godesk` 替换为实际宿主账号；`install.sh --host-user` 会自动处理。
- 如果 `systemctl` 不在 `/usr/bin/systemctl`，需要同时调整 sudoers 与宿主代码路径；Ubuntu 24.04 默认路径一致。
- 规则过宽（例如允许 `systemctl *`）会扩大提权面，不推荐。
- 宿主以 root 运行时不需要 sudoers，但仍需要 grants。
- 提权失败时插件返回 `privilege_missing`，提示“宿主账号缺少 sudoers 规则”。

## 10. 安装插件与配置

打包（在仓库根目录）：

```sh
ext pkg
# 生成 dist/cn.ezios.ecm-0.1.0.zip
```

安装：

- 独立宿主：打开 `http://127.0.0.1:5001/host/`，安装 ZIP 并点击“启用”。
- GoDesk：在「扩展」中安装同一 ZIP，启用。
- 开发：在仓库根目录运行 `ext dev`，自动安装、启用并在保存后更新（数据在 `.ext/`）。

启用后在宿主的扩展配置表单中确认以下配置（保存即热生效，无需重启插件）：

| 键 | 类型 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `caddyBinary` | string | `/opt/caddy/caddy` | 绝对路径 | 诊断与 exec 使用的 Caddy 二进制 |
| `mainConfig` | string | `/opt/caddy/config/Caddyfile` | 绝对路径 | 主 Caddyfile |
| `snippetDir` | string | `/opt/caddy/config/conf.d` | 绝对路径 | 启用的站点片段目录；停用目录自动为 `<dir>.disabled` |
| `sitesRoot` | string | `/opt/caddy/sites` | 绝对路径 | 新建静态站的默认根目录 |
| `serviceUnit` | string | `caddy.service` | `*.service` | 传给 `host.services.*` 的单元名 |
| `logLines` | number | 500 | 100–2000 | 日志默认行数 |
| `certProbeHours` | number | 6 | 1–168 | 证书探测缓存 TTL |
| `backupKeep` | number | 100 | 10–1000 | 备份保留数量 |

说明：

- 目录配置是普通字符串，不会在保存配置时自动创建；首次使用或“诊断 → 生成初始配置”会创建。
- 修改 `sitesRoot` 只影响之后创建的站点。
- 如果主 Caddyfile 不在默认路径，务必同步修改 `mainConfig`，否则初始化会写到别处。
- 配置值非法（相对路径、空值、越界数字）时，插件回退到默认值并在诊断中给出警告。

## 11. 首次初始化与验证

1. 打开插件页面，进入「诊断」。
2. 若主 Caddyfile 尚未创建，点击「生成初始配置」。如果文件已存在且非空，插件会要求二次确认，绝不静默覆盖。
3. 诊断清单应全部正常：二进制、版本、主 Caddyfile、受管标记、片段目录、停用目录、站点根目录、systemd 单元、服务授权、journald、模块、整体校验。
4. 打开「全局配置」，确认受管块：

   ```caddyfile
   # >>> ext-caddy-manage:global
   {
   	admin 127.0.0.1:2019
   }
   # <<< ext-caddy-manage:global
   import conf.d/*.caddy
   ```

   块的注释、`import` 行以外的内容不会被表单改写；额外全局指令写在受管块内。

5. 创建第一个静态站点（HTTPS 可关闭），保存并重载，确认片段出现在 `/opt/caddy/config/conf.d/<slug>.caddy`，权限 0644。

命令行验证：

```sh
# 插件健康检查（路径按实际监听地址）
curl -sS http://127.0.0.1:5001/extensions/cn.ezios.ecm/api/health

# Caddy 配置与运行状态
/opt/caddy/caddy validate --config /opt/caddy/config/Caddyfile --adapter caddyfile
systemctl is-active caddy.service

# 站点（示例域名与端口）
curl -sS -H 'Host: example.com' http://127.0.0.1/
```

服务控制验证：在概览页点击启动/停止/重启；失败时按第 13 节排查。日志页应显示 `journalctl -o short-iso` 的输出，并能按站点域名过滤。

## 12. 日常运维

备份：

- 位置：`<宿主 data-dir>/plugins/cn.ezios.ecm/data/backups/`。
- 文件名：`<UTC 时间戳Z>--<原因>--<原文件名>`，例如 `20261125T060000Z--form--blog.caddy`。
- 原因区分作用域：主配置使用 `global`、`init`、`restore-global`；站点使用 `create`、`form`、`raw`、`enable`、`disable`、`delete`、`restore`。即使主配置与站点片段同名（例如主配置叫 `blog.caddy`），备份列表与恢复也不会混淆。
- 触发：表单/原文保存、启用、停用、删除、恢复、主配置保存、初始化覆盖。
- 保留：按配置 `backupKeep` 保留最新 N 份（按文件名排序）；备份文件 0600。
- 恢复走与保存相同的校验、整体 validate、reload、失败回滚流程，可在站点详情或全局配置页操作。

漂移：手工修改片段或主 Caddyfile 后，详情页会显示“磁盘上的片段已被外部修改”。选择“以磁盘为准”会把磁盘内容作为新基线；选择“用表单覆盖”会强制写回表单模型。插件不会自动合并。

升级 Caddy：

```sh
sudo ./deploy/install.sh --host-user godesk --caddy-version 2.11.0
sudo systemctl restart caddy.service
```

升级前建议备份 `/opt/caddy/config` 与插件数据目录。插件会执行 `caddy validate`，发现不兼容会拒绝写入。

升级插件：重新 `ext pkg` 并在宿主安装新 ZIP；业务数据与配置保留。宿主的 `run` 会先卸载同 ID 插件（默认保留业务数据）。

卸载：

1. 在宿主中禁用、卸载插件（默认保留业务数据）。
2. `sudo systemctl disable --now caddy.service`。
3. 按需删除 `/etc/systemd/system/caddy.service`、`/etc/sudoers.d/ext-caddy-manage`、`/opt/caddy`。删除 `/opt/caddy/sites` 会丢失站点文件，先确认。
4. `sudo systemctl daemon-reload`。

## 13. 故障排查

| 现象/错误码 | 常见原因 | 处理 |
| --- | --- | --- |
| `caddy_missing` | 二进制路径错误或不可执行 | 检查 `caddyBinary`、`ls -l /opt/caddy/caddy`、手动执行 `caddy version` |
| `not_initialized` | 主 Caddyfile 不存在 | 诊断页点“生成初始配置”，或手动创建 |
| `markers_missing` | 主配置缺少受管标记行 | 恢复标记块；全局表单禁用时可用原文编辑 |
| `grant_missing` | 宿主未加载 grants 或单元/操作未授权 | 合并 `deploy/grants.example.json`，重启宿主 |
| `privilege_missing` | sudoers 规则缺失或命令不匹配 | 安装 `sudoers.example`，核对路径与参数 |
| `journal_unavailable` | 宿主账号不在 `systemd-journal` 组 | `usermod -aG systemd-journal <账号>`，重新登录 |
| `reload_failed`（connection refused） | Caddy 未运行或 Admin API 地址不一致 | 启动服务；确认受管块中 `admin 127.0.0.1:2019` |
| `validate_failed` | Caddyfile 语法/导入/站点片段错误 | 查看错误中的文件与行号；修复后重试 |
| 站点 403 | 站点根目录或配置不可被 caddy 读取 | 修复 `/opt/caddy` 属主与 0755/0644 |
| 端口 80/443 启动失败 | 端口被占用或缺少绑定能力 | `ss -lntp` 检查；确认 unit 的 AmbientCapabilities |
| 证书“未知” | 域名未解析到本机、443 不可达或尚未签发 | 检查 DNS/防火墙；配置 staging 时证书不受信任 |
| 日志为空 | 窗口内无匹配主机或被高流量挤出 | 增大 `logLines`（最大 2000）或稍后重试 |
| 保存提示冲突（409） | 文件被外部修改 | 按提示选择“以磁盘为准”或“用表单覆盖” |

查看宿主与插件日志：宿主的 `--data-dir` 下 `logs/<插件 id>-<版本>.log`，以及运行宿主的终端输出。

## 14. 安全清单

- 独立宿主默认只监听 `127.0.0.1:5001` 且没有登录；不要直接暴露到公网，远程访问请置于带认证的反向代理之后。
- sudoers 只授予三条完整命令；不要放宽为 `systemctl *`。
- grants 只列 `caddy.service` 与所需动作。
- Caddy 以无特权 `caddy` 账号运行，仅通过 AmbientCapabilities 绑定低端口。
- 配置与站点目录属宿主账号，`caddy` 只读；插件不写 `/var/lib/caddy`。
- 插件备份 0600；插件不会把密码、提交的明文密码或完整模型写入日志。
- Basic Auth 的 bcrypt 哈希会出现在站点片段中（0644），视为敏感配置；不要将配置目录共享给不受信任的账号。
- Caddy Admin API 保持在回环地址；受管全局块中的 `admin` 行不要改成公网地址。
- 插件写入使用同目录临时文件 + rename，并在应用前备份、整体校验；reload 失败自动回滚，回滚失败会保留备份并明确报错。
