#!/usr/bin/env bash
# ext-caddy-manage 部署脚本。
#
# 在 Ubuntu 24.04+（systemd、amd64 或 arm64）上以 root 运行：
#   sudo ./deploy/install.sh --host-user godesk
#
# 脚本只负责系统层准备：Caddy 二进制、caddy 账号、目录、初始 Caddyfile、
# systemd unit。sudoers 由系统管理员配置。脚本不会启动 Caddy 或安装插件。
# 可重复执行；已存在的 Caddyfile 永远不会被覆盖。

set -euo pipefail

CADDY_VERSION="2.10.2"
TARBALL=""
HOST_USER="godesk"
HOST_GROUP=""
ALLOW_UNVERIFIED=0

CADDY_ROOT="/opt/caddy"
CADDY_TARGET="/opt/caddy/caddy"
CONFIG_ROOT="/opt/caddy/config"
MAIN_CONFIG="/opt/caddy/config/Caddyfile"
SNIPPET_DIR="/opt/caddy/config/conf.d"
DISABLED_DIR="/opt/caddy/config/conf.d.disabled"
SITES_ROOT="/opt/caddy/sites"
UNIT_TARGET="/etc/systemd/system/caddy.service"

usage() {
  cat <<'EOF'
用法：sudo ./deploy/install.sh [选项]

选项：
  --caddy-version <版本>  要安装的 Caddy 版本（默认 2.10.2）
  --tarball <文件>        使用本地 Caddy 发布包（caddy_<版本>_linux_<架构>.tar.gz）
  --host-user <账号>      运行 Extension Host 的账号（默认 godesk）
  --host-group <组>       上述账号的组（默认取该账号的主组）
  --allow-unverified      允许安装无法校验的本地 tarball 或下载包（不推荐）
  -h, --help              显示本帮助

示例：
  sudo ./deploy/install.sh --host-user godesk
  sudo ./deploy/install.sh --host-user godesk --caddy-version 2.10.2
  sudo ./deploy/install.sh --host-user godesk --tarball /tmp/caddy_2.10.2_linux_amd64.tar.gz --allow-unverified
EOF
}

say() { printf '==> %s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --caddy-version)
      [[ $# -ge 2 ]] || die "--caddy-version 需要参数"
      CADDY_VERSION="$2"
      shift 2
      ;;
    --tarball)
      [[ $# -ge 2 ]] || die "--tarball 需要参数"
      TARBALL="$2"
      shift 2
      ;;
    --host-user)
      [[ $# -ge 2 ]] || die "--host-user 需要参数"
      HOST_USER="$2"
      shift 2
      ;;
    --host-group)
      [[ $# -ge 2 ]] || die "--host-group 需要参数"
      HOST_GROUP="$2"
      shift 2
      ;;
    --allow-unverified)
      ALLOW_UNVERIFIED=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "未知参数：$1"
      ;;
  esac
done

[[ $(id -u) -eq 0 ]] || die "必须以 root 运行（sudo ./deploy/install.sh ...）"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
UNIT_SOURCE="$SCRIPT_DIR/caddy.service"
[[ -f "$UNIT_SOURCE" ]] || die "缺少 $UNIT_SOURCE（请从仓库 deploy/ 目录运行）"

[[ "$CADDY_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Caddy 版本格式应为 x.y.z，例如 2.10.2"
[[ "$HOST_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "宿主账号名不合法：$HOST_USER"
id -u "$HOST_USER" >/dev/null 2>&1 || die "宿主账号 $HOST_USER 不存在；请先创建，或用 --host-user 指定运行 Extension Host 的账号"
if [[ -z "$HOST_GROUP" ]]; then
  HOST_GROUP=$(id -gn "$HOST_USER")
fi
[[ "$HOST_GROUP" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "宿主组名不合法：$HOST_GROUP"
getent group "$HOST_GROUP" >/dev/null 2>&1 || die "宿主组 $HOST_GROUP 不存在"

case "$(uname -m)" in
  x86_64|amd64)  CADDY_ARCH="amd64" ;;
  aarch64|arm64) CADDY_ARCH="arm64" ;;
  *) die "不支持的 CPU 架构：$(uname -m)" ;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ecm-install.XXXXXX")
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT
umask 022

fetch() { # fetch <url> <dest>
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    die "需要 curl 或 wget 下载 Caddy"
  fi
}

# ---------------------------------------------------------------- Caddy 二进制
NEED_CADDY=1
if [[ -z "$TARBALL" && -x "$CADDY_TARGET" ]]; then
  INSTALLED_VERSION=$("$CADDY_TARGET" version 2>/dev/null | awk 'NR==1{print $1}' || true)
  if [[ "$INSTALLED_VERSION" == "v$CADDY_VERSION" || "$INSTALLED_VERSION" == "$CADDY_VERSION" ]]; then
    NEED_CADDY=0
    say "已安装 Caddy $INSTALLED_VERSION，跳过下载与替换"
  fi
fi

if [[ $NEED_CADDY -eq 1 ]]; then
  ASSET="caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"
  install -d -o root -g root -m 0755 "$CADDY_ROOT"
  mkdir -p "$TMP/caddy-extract"
  if [[ -n "$TARBALL" ]]; then
    [[ -f "$TARBALL" ]] || die "本地发布包不存在：$TARBALL"
    if [[ $ALLOW_UNVERIFIED -ne 1 ]]; then
      die "本地 tarball 无法自动校验；确认来源可信后加 --allow-unverified"
    fi
    warn "本地发布包未经校验：$TARBALL"
    tar -xzf "$TARBALL" --no-same-owner --no-same-permissions -C "$TMP/caddy-extract"
  else
    URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${ASSET}"
    say "下载 Caddy v$CADDY_VERSION（linux/$CADDY_ARCH）"
    fetch "$URL" "$TMP/$ASSET"
    # 校验和来自同一发布源，用于发现下载损坏；下载失败时仅警告。
    VERIFIED=0
    if fetch "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt" "$TMP/checksums.txt"; then
      EXPECTED=$(awk -v name="$ASSET" '$2 == name { print $1; exit }' "$TMP/checksums.txt")
      if [[ -n "$EXPECTED" ]] && command -v sha512sum >/dev/null 2>&1; then
        ACTUAL=$(sha512sum "$TMP/$ASSET" | awk '{print $1}')
        [[ "$ACTUAL" == "$EXPECTED" ]] || die "Caddy 发布包校验和不匹配"
        VERIFIED=1
        say "校验和验证通过"
      fi
    fi
    if [[ $VERIFIED -ne 1 ]]; then
      if [[ $ALLOW_UNVERIFIED -eq 1 ]]; then
        warn "无法校验下载的 Caddy 发布包；按 --allow-unverified 继续"
      else
        die "无法校验下载的 Caddy 发布包；确认来源可信后使用 --allow-unverified"
      fi
    fi
    tar -xzf "$TMP/$ASSET" --no-same-owner --no-same-permissions -C "$TMP/caddy-extract"
  fi
  # The archive is operator-supplied when --tarball is used. Never follow a
  # symlink from it into a root-readable file, and require a regular file.
  [[ -f "$TMP/caddy-extract/caddy" && ! -L "$TMP/caddy-extract/caddy" ]]     || die "发布包中的 caddy 必须是普通文件（不允许符号链接）"
  install -o root -g root -m 0755 "$TMP/caddy-extract/caddy" "$CADDY_TARGET"
  say "已安装 $CADDY_TARGET"
fi

INSTALLED_VERSION=$("$CADDY_TARGET" version 2>/dev/null | awk 'NR==1{print $1}' || true)
say "Caddy 版本：${INSTALLED_VERSION:-未知}"
if [[ "$INSTALLED_VERSION" =~ ^v?([0-9]+)\.([0-9]+)\. ]]; then
  MAJOR="${BASH_REMATCH[1]}"
  MINOR="${BASH_REMATCH[2]}"
  if (( MAJOR < 2 || (MAJOR == 2 && MINOR < 8) )); then
    warn "插件要求 Caddy 2.8 及以上（当前 $INSTALLED_VERSION），basic_auth/validate/fmt 可能不可用"
  fi
else
  warn "无法识别 Caddy 版本，请确认它是官方 2.x 静态二进制"
fi

# ---------------------------------------------------------------- caddy 账号
if ! getent group caddy >/dev/null 2>&1; then
  say "创建系统组 caddy"
  groupadd --system caddy
fi
if ! id -u caddy >/dev/null 2>&1; then
  say "创建系统账号 caddy"
  useradd --system --gid caddy --home-dir /var/lib/caddy \
    --shell /usr/sbin/nologin --comment "Caddy web server" caddy
fi
install -d -o caddy -g caddy -m 0750 /var/lib/caddy

# ---------------------------------------------------------------- 目录与属主
say "准备目录与权限"
install -d -o root -g root -m 0755 "$CADDY_ROOT"
install -d -o "$HOST_USER" -g "$HOST_GROUP" -m 0755 "$CONFIG_ROOT"
install -d -o "$HOST_USER" -g "$HOST_GROUP" -m 0755 "$SNIPPET_DIR"
install -d -o "$HOST_USER" -g "$HOST_GROUP" -m 0755 "$DISABLED_DIR"
install -d -o "$HOST_USER" -g "$HOST_GROUP" -m 0755 "$SITES_ROOT"

# ---------------------------------------------------------------- 初始 Caddyfile
if [[ -e "$MAIN_CONFIG" || -L "$MAIN_CONFIG" ]]; then
  say "保留已有主 Caddyfile：$MAIN_CONFIG"
else
  say "写入初始主 Caddyfile"
  {
    printf '%s\n' \
      '# >>> ext-caddy-manage:global' \
      '{' \
      $'\tadmin 127.0.0.1:2019' \
      '}' \
      '# <<< ext-caddy-manage:global' \
      'import conf.d/*.caddy'
  } > "$TMP/Caddyfile"
  install -o "$HOST_USER" -g "$HOST_GROUP" -m 0644 "$TMP/Caddyfile" "$MAIN_CONFIG"
fi

# ---------------------------------------------------------------- systemd unit
UNIT_CHANGED=0
if [[ -f "$UNIT_TARGET" ]] && cmp -s "$UNIT_SOURCE" "$UNIT_TARGET"; then
  say "systemd unit 已是最新：$UNIT_TARGET"
else
  if [[ -e "$UNIT_TARGET" || -L "$UNIT_TARGET" ]]; then
    UNIT_BACKUP="$UNIT_TARGET.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -a "$UNIT_TARGET" "$UNIT_BACKUP"
    say "已备份原 unit：$UNIT_BACKUP"
    rm -f "$UNIT_TARGET"
  fi
  say "安装 systemd unit：$UNIT_TARGET"
  install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
  UNIT_CHANGED=1
fi
if [[ $UNIT_CHANGED -eq 1 ]]; then
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl daemon-reload || warn "systemctl daemon-reload 失败，请手动执行"
  else
    warn "当前环境未运行 systemd，跳过 daemon-reload"
  fi
fi

# ---------------------------------------------------------------- 后续步骤
cat <<EOF

安装完成。系统层还需要以下操作：

1. 启动 Caddy（脚本不会自动启动）：
     sudo systemctl daemon-reload
     sudo systemctl enable --now caddy.service
     sudo systemctl status caddy.service

2. 让宿主账号读取 journald 日志（重新登录或重启宿主进程后生效）：
     sudo usermod -aG systemd-journal $HOST_USER

3. 非 root 宿主的启停和重启权限由系统管理员配置，参见 deploy/README.md 的 sudoers 小节。

4. 安装并启用本插件（在项目根目录）：
     ext pkg
   然后在宿主的 /host/ 安装 dist/cn.ezios.ecm-0.1.0.zip 并启用。

5. 检查插件配置（宿主扩展配置表单，保存后热生效）：
     caddyBinary   $CADDY_TARGET
     mainConfig    $MAIN_CONFIG
     snippetDir    $SNIPPET_DIR
     sitesRoot     $SITES_ROOT
     serviceUnit   caddy.service

6. 打开插件「诊断」页确认：二进制、Caddyfile、目录、systemd 单元、
   journald 日志、整体校验均为正常。首次使用可点「生成初始配置」。

更多说明见 deploy/README.md。
EOF
