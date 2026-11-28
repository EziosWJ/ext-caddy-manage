#!/usr/bin/env bash
# ext-caddy-manage 端到端测试（设计文档 §14.1）。
#
# 在临时目录中构建 Extension Host、下载或复用 Caddy 二进制，用高位端口启动
# 非 systemd 的 Caddy 与 `ext run` 宿主，然后通过真实 Host API 驱动插件完成：
# 初始化 → 新建静态站 → 片段断言 → validate → reload → HTTP 命中 → 表单修改 →
# 原文保存 → 冲突 409 → 停用/启用 → 删除 → 备份恢复 → fmt。
#
# 依赖：go、curl、python3、tar、grep。不需要 root，不需要 jq。
#
# 环境变量：
#   EXT_SOURCE    Extension Host 源码目录（默认 <仓库>/../Extension-Host）
#   CADDY_VERSION 下载的 Caddy 版本（默认 2.10.2）
#   CADDY_TARBALL 本地 Caddy 发布包 caddy_<版本>_linux_<架构>.tar.gz
#   CADDY_BIN     直接使用已有 caddy 二进制（优先于下载）
#   E2E_SYSTEMD=1 额外读取 caddy.service 状态（需要 systemd 与已安装的 unit）
#   E2E_KEEP=1    保留临时目录与日志
#
# 注意：初始化步骤会短暂使用 Caddy 默认的 Admin 端口 2019；同一台机器上不要
# 并行运行多个 e2e 实例。

set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
EXT_SOURCE=${EXT_SOURCE:-"$ROOT/../Extension-Host"}
CADDY_VERSION=${CADDY_VERSION:-"2.10.2"}
CADDY_VERSION=${CADDY_VERSION#v}
CADDY_TARBALL=${CADDY_TARBALL:-}
CADDY_BIN=${CADDY_BIN:-}
E2E_SYSTEMD=${E2E_SYSTEMD:-0}
E2E_KEEP=${E2E_KEEP:-0}

say() { printf '==> %s\n' "$*"; }
skip() { printf 'SKIP: %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '缺少依赖：%s\n' "$1" >&2
    exit 1
  }
}

need go
need curl
need python3
need tar
need grep
need awk

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ecm-e2e.XXXXXX")
RESP="$WORK/last-response.json"
HTTP_STATUS=""
CADDY_PID=""
HOST_PID=""
DUMMY_PID=""

fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  if [[ -d ${WORK:-} ]]; then
    local log
    for log in "$WORK/logs/host.log" "$WORK/logs/caddy.log"; do
      if [[ -s "$log" ]]; then
        printf '\n--- %s（末尾 40 行）---\n' "$log"
        tail -n 40 "$log" || true
      fi
    done
    if [[ -s ${RESP:-} ]]; then
      printf '\n--- 最后一次 API 响应（截断）---\n'
      head -c 4000 "$RESP" || true
      printf '\n'
    fi
  fi
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n ${HOST_PID:-} ]]; then
    kill "$HOST_PID" 2>/dev/null
    wait "$HOST_PID" 2>/dev/null
  fi
  if [[ -n ${CADDY_PID:-} ]]; then
    kill "$CADDY_PID" 2>/dev/null
    wait "$CADDY_PID" 2>/dev/null
  fi
  if [[ -n ${DUMMY_PID:-} ]]; then
    kill "$DUMMY_PID" 2>/dev/null
    wait "$DUMMY_PID" 2>/dev/null
  fi
  if [[ -n ${WORK:-} && -d ${WORK:-} ]]; then
    if [[ ${E2E_KEEP} == 1 ]]; then
      printf '临时目录保留：%s\n' "$WORK"
    else
      rm -rf "$WORK"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------- 工具函数

cat > "$WORK/jsonq.py" <<'PY'
import json
import sys


def die(message):
    sys.stderr.write(message + "\n")
    sys.exit(2)


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as error:
        die(f"无法读取 JSON {path}: {error}")


def get(value, path):
    if path in ("", "."):
        return value
    current = value
    for token in path.split("."):
        if isinstance(current, dict):
            if token not in current:
                die(f"缺少字段 {path}")
            current = current[token]
        elif isinstance(current, list):
            try:
                current = current[int(token)]
            except (ValueError, IndexError):
                die(f"字段路径无效 {path}")
        else:
            die(f"字段路径无效 {path}")
    return current


def same(actual, raw):
    try:
        expected = json.loads(raw)
    except ValueError:
        expected = raw
    return actual == expected


def main():
    if len(sys.argv) < 3:
        die("用法：jsonq.py <ok|error|get|getjson|eq> <file> [参数]")
    command, path = sys.argv[1], sys.argv[2]
    data = load(path)
    argument = sys.argv[3] if len(sys.argv) > 3 else ""
    if command == "ok":
        if data.get("ok") is not True:
            die("响应 ok 不为 true: " + json.dumps(data, ensure_ascii=False)[:2000])
    elif command == "error":
        if data.get("ok") is not False or not isinstance(data.get("error"), dict):
            die("响应不是错误结构: " + json.dumps(data, ensure_ascii=False)[:2000])
        code = data["error"].get("code")
        if argument and code != argument:
            die(f"错误码 {code} != {argument}")
    elif command == "get":
        value = get(data, argument)
        if isinstance(value, str):
            sys.stdout.write(value)
        else:
            sys.stdout.write(json.dumps(value, ensure_ascii=False))
    elif command == "getjson":
        sys.stdout.write(json.dumps(get(data, argument), ensure_ascii=False))
    elif command == "eq":
        actual = get(data, argument)
        if not same(actual, sys.argv[4] if len(sys.argv) > 4 else ""):
            die(f"{argument} = {json.dumps(actual, ensure_ascii=False)}，期望 {sys.argv[4] if len(sys.argv) > 4 else ''}")
    else:
        die(f"未知命令 {command}")


if __name__ == "__main__":
    main()
PY

j() { python3 "$WORK/jsonq.py" "$@"; }

assert_ok() {
  j ok "$RESP" || fail "$1"
}

assert_status() {
  [[ "$HTTP_STATUS" == "$1" ]] || fail "$2（HTTP $HTTP_STATUS）"
}

assert_eq() { # assert_eq <消息> <字段路径> <期望值>
  j eq "$RESP" "$2" "$3" || fail "$1"
}

assert_error() { # assert_error <消息> <错误码>
  j error "$RESP" "$2" || fail "$1"
}

http_call() { # http_call <METHOD> <插件 API 路径> [JSON body 文件]
  local method="$1"
  local path="$2"
  local bodyfile="${3:-}"
  local args=(--noproxy '*' -sS --max-time 180 -o "$RESP" -w '%{http_code}'
    -X "$method" -H 'Accept: application/json')
  if [[ -n "$bodyfile" ]]; then
    args+=(-H 'Content-Type: application/json' --data-binary "@$bodyfile")
  fi
  HTTP_STATUS=$(curl "${args[@]}" "${API_BASE}${path}") || true
  if [[ ! "$HTTP_STATUS" =~ ^[1-5][0-9][0-9]$ ]]; then
    fail "curl 请求失败：$method $path"
  fi
}

wait_http() { # wait_http <URL> [秒]
  local url="$1"
  local timeout="${2:-30}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if curl --noproxy '*' -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# ---------------------------------------------------------------- 准备

say "临时目录：$WORK"
mkdir -p "$WORK"/bin "$WORK"/etc "$WORK"/caddy "$WORK"/logs "$WORK"/sites \
  "$WORK"/host-data "$WORK"/caddy-home/config "$WORK"/caddy-home/data

PORT_LINE=$(python3 - <<'PY'
import socket

sockets = []
ports = []
for _ in range(5):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
    ports.append(str(sock.getsockname()[1]))
print(" ".join(ports))
PY
)
read -r ADMIN_PORT HTTP_PORT HTTPS_PORT HOST_PORT PROXY_PORT <<< "$PORT_LINE" || fail "无法分配空闲端口"
for port in "$ADMIN_PORT" "$HTTP_PORT" "$HTTPS_PORT" "$HOST_PORT" "$PROXY_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] || fail "无法分配空闲端口"
done
say "端口：admin=$ADMIN_PORT http=$HTTP_PORT https=$HTTPS_PORT host=$HOST_PORT proxy=$PROXY_PORT"

# 初始化会用默认 admin 127.0.0.1:2019 写一次骨架并尝试 reload。
# - 若 2019 已被真实服务监听，使用预置配置，避免调用现有 Caddy。
# - 若端口空闲或连接挂起，初始化期间临时占用它并运行只应答 200 的 Admin 桩。
#   这样既不会误连后来启动的真实服务，也能让初始化确定完成；随后立即关闭。
PORT_2019_MODE=$(python3 - <<'PY'
import errno
import socket
import time

mode = "refused"
for attempt in range(3):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    try:
        sock.connect(("127.0.0.1", 2019))
        mode = "busy"
        break
    except socket.timeout:
        mode = "blocked"
    except OSError as error:
        if error.errno != errno.ECONNREFUSED:
            mode = "blocked"
    finally:
        sock.close()
    if mode != "refused":
        break
    time.sleep(0.2)
print(mode)
PY
)
case "$PORT_2019_MODE" in
  busy)
    skip "端口 2019 已被占用。在隔离 Caddyfile 中预置测试端口，跳过默认初始化。"
    ;;
  refused)
    say "端口 2019 空闲，初始化时将临时占用它作为 Admin 桩，避免与后来启动的服务竞争"
    ;;
  blocked)
    say "端口 2019 连接挂起，初始化时将临时启动 Admin 桩"
    ;;
  *)
    fail "无法判断端口 2019 状态：$PORT_2019_MODE"
    ;;
esac

MAIN_CONFIG="$WORK/etc/Caddyfile"
SNIPPET_DIR="$WORK/etc/conf.d"
DISABLED_DIR="$WORK/etc/conf.d.disabled"
SITES_ROOT="$WORK/sites"
CADDY_HOME="$WORK/caddy-home"

export CADDY MAIN_CONFIG SNIPPET_DIR DISABLED_DIR SITES_ROOT
export ADMIN_PORT HTTP_PORT HTTPS_PORT
export XDG_CONFIG_HOME="$CADDY_HOME/config"
export XDG_DATA_HOME="$CADDY_HOME/data"

say "构建 Extension Host：$EXT_SOURCE"
[[ -d "$EXT_SOURCE" ]] || fail "Extension Host 源码目录不存在：$EXT_SOURCE"
if ! (cd "$EXT_SOURCE" && GOWORK=off CGO_ENABLED=0 go build -o "$WORK/bin/ext" ./cmd/ext); then
  fail "Extension Host 构建失败"
fi

PKG="$WORK/package"
mkdir -p "$PKG"
cp "$ROOT/manifest.json" "$PKG/"
cp -R "$ROOT/lua" "$ROOT/web" "$PKG/"
[[ -f "$PKG/lua/init.lua" ]] || fail "插件缺少 lua/init.lua"
[[ -f "$PKG/web/index.html" ]] || fail "插件缺少 web/index.html"

if [[ -n "$CADDY_BIN" ]]; then
  if [[ -x "$CADDY_BIN" ]]; then
    CADDY=$(cd -- "$(dirname -- "$CADDY_BIN")" && pwd)/$(basename -- "$CADDY_BIN")
  elif command -v "$CADDY_BIN" >/dev/null 2>&1; then
    CADDY=$(command -v "$CADDY_BIN")
  else
    fail "CADDY_BIN 不可执行：$CADDY_BIN"
  fi
else
  if [[ -n "$CADDY_TARBALL" ]]; then
    [[ -f "$CADDY_TARBALL" ]] || fail "CADDY_TARBALL 不存在：$CADDY_TARBALL"
    say "使用本地 Caddy 发布包：$CADDY_TARBALL"
    tar -xzf "$CADDY_TARBALL" -C "$WORK/caddy" || fail "解压 Caddy 发布包失败"
  else
    case "$(uname -m)" in
      x86_64|amd64)  CADDY_ARCH="amd64" ;;
      aarch64|arm64) CADDY_ARCH="arm64" ;;
      *) fail "不支持的 CPU 架构：$(uname -m)" ;;
    esac
    CADDY_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"
    say "下载 Caddy v$CADDY_VERSION（linux/$CADDY_ARCH）"
    curl -fL --retry 3 --connect-timeout 15 -o "$WORK/caddy.tar.gz" "$CADDY_URL" \
      || fail "下载 Caddy 失败（可用 CADDY_TARBALL 或 CADDY_BIN）"
    tar -xzf "$WORK/caddy.tar.gz" -C "$WORK/caddy" || fail "解压 Caddy 失败"
  fi
  CADDY="$WORK/caddy/caddy"
  [[ -f "$CADDY" ]] || fail "发布包中未找到 caddy 二进制"
  chmod +x "$CADDY"
fi
export CADDY
[[ -x "$CADDY" ]] || fail "Caddy 二进制不可执行：$CADDY"
say "Caddy：$("$CADDY" version | awk 'NR==1{print $1}')"

# ---------------------------------------------------------------- 启动宿主

API_BASE="http://127.0.0.1:$HOST_PORT/extensions/de.jianwang.caddy-manage/api"
HOST_BASE="http://127.0.0.1:$HOST_PORT"

say "打包并启动 Extension Host 与插件（ext run）"
"$WORK/bin/ext" pack "$PKG" -o "$WORK/plugin.zip" || fail "插件打包失败"
"$WORK/bin/ext" run "$WORK/plugin.zip" --listen "127.0.0.1:$HOST_PORT" --data-dir "$WORK/host-data" \
  >"$WORK/logs/host.log" 2>&1 &
HOST_PID=$!

if ! wait_http "$HOST_BASE/api/v1/extensions" 90; then
  fail "宿主未在 90 秒内就绪"
fi
if ! wait_http "$API_BASE/health" 90; then
  fail "插件 API 未就绪（可能 Lua 加载失败，见宿主日志）"
fi

say "写入插件配置"
python3 - "$WORK/body.json" <<'PY'
import json
import os
import sys

json.dump({
    "caddyBinary": os.environ["CADDY"],
    "mainConfig": os.environ["MAIN_CONFIG"],
    "snippetDir": os.environ["SNIPPET_DIR"],
    "sitesRoot": os.environ["SITES_ROOT"],
    "serviceUnit": "caddy.service",
    "logLines": 200,
    "certProbeHours": 6,
    "backupKeep": 20,
}, open(sys.argv[1], "w", encoding="utf-8"))
PY
HTTP_STATUS=$(curl --noproxy '*' -sS --max-time 30 -o "$RESP" -w '%{http_code}' \
  -X PUT -H 'Content-Type: application/json' --data-binary "@$WORK/body.json" \
  "$HOST_BASE/api/v1/extensions/de.jianwang.caddy-manage/config") || true
assert_status 200 "插件配置保存失败：$(head -c 2000 "$RESP" 2>/dev/null || true)"

# ---------------------------------------------------------------- 初始化

say "健康检查"
http_call GET /health
assert_status 200 "health 请求失败"
assert_ok "health 未返回 ok"
assert_eq "health.ready" data.ready true
assert_eq "health.mainConfig" data.mainConfig "$MAIN_CONFIG"
assert_eq "health.snippetDir" data.snippetDir "$SNIPPET_DIR"
assert_eq "health.sitesRoot" data.sitesRoot "$SITES_ROOT"

say "初始化目录与主 Caddyfile"
if [[ "$PORT_2019_MODE" == "busy" ]]; then
  mkdir -p "$SNIPPET_DIR" "$DISABLED_DIR" "$SITES_ROOT"
  cat > "$MAIN_CONFIG" <<EOF
# >>> ext-caddy-manage:global
{
  admin 127.0.0.1:$ADMIN_PORT
}
# <<< ext-caddy-manage:global
import conf.d/*.caddy
EOF
else
  cat > "$WORK/admin2019.py" <<'PY'
import http.server
import socketserver


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", 2019), Handler) as httpd:
    httpd.serve_forever()
PY
  python3 "$WORK/admin2019.py" >"$WORK/logs/admin2019.log" 2>&1 &
  DUMMY_PID=$!
  if ! wait_http "http://127.0.0.1:2019/config/" 10; then
    fail "临时 Admin 桩未在 10 秒内就绪"
  fi
  if ! kill -0 "$DUMMY_PID" 2>/dev/null; then
    fail "临时 Admin 桩已退出（端口 2019 可能被其他进程抢占）"
  fi
  printf '{}\n' > "$WORK/body.json"
  http_call POST /diagnostics/init "$WORK/body.json"
  assert_status 200 "初始化失败"
  assert_ok "初始化未返回 ok"
  assert_eq "init.written" data.written true
fi
[[ -f "$MAIN_CONFIG" ]] || fail "初始化后主 Caddyfile 不存在"
grep -Fq -- '# >>> ext-caddy-manage:global' "$MAIN_CONFIG" || fail "主 Caddyfile 缺少受管标记"

http_call GET /health
assert_eq "初始化后 health.initialized" data.initialized true
assert_eq "初始化后 health.hasMarkers" data.hasMarkers true

if [[ -n ${DUMMY_PID:-} ]]; then
  kill "$DUMMY_PID" 2>/dev/null
  wait "$DUMMY_PID" 2>/dev/null || true
  DUMMY_PID=""
  say "已关闭临时 Admin 桩"
fi

say "写入带高位端口的受管全局块（使用原文保存）"
http_call GET /global
assert_status 200 "读取全局配置失败"
assert_ok "读取全局配置未返回 ok"
j get "$RESP" data.raw > "$WORK/main-baseline.txt"
export MAIN_BASELINE="$WORK/main-baseline.txt"

python3 - "$WORK/body.json" <<'PY'
import json
import os
import sys

content = (
    "# >>> ext-caddy-manage:global\n"
    "{\n"
    "\tadmin 127.0.0.1:" + os.environ["ADMIN_PORT"] + "\n"
    "\thttp_port " + os.environ["HTTP_PORT"] + "\n"
    "\thttps_port " + os.environ["HTTPS_PORT"] + "\n"
    "}\n"
    "# <<< ext-caddy-manage:global\n"
    "import conf.d/*.caddy\n"
)
json.dump({
    "content": content,
    "baseline": open(os.environ["MAIN_BASELINE"], encoding="utf-8").read(),
    "force": False,
}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /global/raw "$WORK/body.json"
assert_status 200 "保存主 Caddyfile 失败"
assert_ok "保存主 Caddyfile 未返回 ok"
assert_eq "global.hasMarkers" data.hasMarkers true
assert_eq "global.savedOnly" data.apply.savedOnly true
grep -Fq -- "admin 127.0.0.1:$ADMIN_PORT" "$MAIN_CONFIG" || fail "主 Caddyfile 缺少管理员端口"
grep -Fq -- "http_port $HTTP_PORT" "$MAIN_CONFIG" || fail "主 Caddyfile 缺少 http_port"
grep -Fq -- "https_port $HTTPS_PORT" "$MAIN_CONFIG" || fail "主 Caddyfile 缺少 https_port"
grep -Fq -- 'import conf.d/*.caddy' "$MAIN_CONFIG" || fail "主 Caddyfile 缺少 import"

say "预览全局表单，不写入主 Caddyfile"
cp "$MAIN_CONFIG" "$WORK/main-before-preview.caddy"
http_call GET /global
assert_status 200 "读取全局表单失败"
python3 - "$RESP" "$WORK/body.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as response:
    detail = json.load(response)["data"]
form = dict(detail["form"], baseline=detail["raw"], email="e2e@example.com")
with open(sys.argv[2], "w", encoding="utf-8") as body:
    json.dump(form, body)
PY
http_call POST /global/preview "$WORK/body.json"
assert_status 200 "预览全局表单失败"
assert_ok "全局表单预览未返回 ok"
j get "$RESP" data.content > "$WORK/main-preview.caddy"
grep -Fq -- 'email e2e@example.com' "$WORK/main-preview.caddy" || fail "全局预览未生成邮箱"
grep -Fq -- 'import conf.d/*.caddy' "$WORK/main-preview.caddy" || fail "全局预览遗漏块外内容"
cmp -s "$MAIN_CONFIG" "$WORK/main-before-preview.caddy" || fail "预览不应修改主 Caddyfile"

say "启动 Caddy（非 systemd，Admin API 127.0.0.1:$ADMIN_PORT）"
"$CADDY" run --config "$MAIN_CONFIG" --adapter caddyfile >"$WORK/logs/caddy.log" 2>&1 &
CADDY_PID=$!
if ! wait_http "http://127.0.0.1:$ADMIN_PORT/config/" 30; then
  fail "Caddy Admin API 未就绪"
fi

say "保存全局表单并核对预览"
http_call POST /global "$WORK/body.json"
assert_status 200 "保存全局表单失败"
assert_ok "全局表单保存未返回 ok"
assert_eq "全局表单已重载" data.apply.reloaded true
cmp -s "$MAIN_CONFIG" "$WORK/main-preview.caddy" || fail "全局预览与实际写入不一致"

# ---------------------------------------------------------------- 新建站点

say "新建静态站点（HTTPS 关闭）"
python3 - "$WORK/body.json" <<'PY'
import json
import sys

model = {
    "name": "E2E Static",
    "type": "static",
    "domains": ["e2e.local"],
    "https": False,
    "group": "默认",
    "note": "e2e",
    "static": {"root": "", "browse": False, "spa": True},
    "security": {
        "basicAuth": [],
        "ipMode": "off",
        "ipList": [],
        "headers": [],
        "hsts": False,
        "encode": True,
    },
}
json.dump({"model": model}, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
PY
http_call POST /site "$WORK/body.json"
assert_status 200 "新建站点失败"
assert_ok "新建站点未返回 ok"
assert_eq "新建站点 slug" data.slug "e2e-static"
assert_eq "新建站点 enabled" data.enabled true
assert_eq "新建站点默认根目录" data.model.static.root "$SITES_ROOT/e2e-static"
assert_eq "新建站点已重载" data.apply.reloaded true

SLUG=$(j get "$RESP" data.slug)
export SLUG
SITE_DIR="$SITES_ROOT/$SLUG"
mkdir -p "$SITE_DIR"
printf 'e2e-static-ok\n' > "$SITE_DIR/index.html"

# ---------------------------------------------------------------- 片段断言

say "断言生成的站点片段"
http_call GET "/site?slug=$SLUG"
assert_status 200 "读取站点详情失败"
assert_ok "读取站点详情未返回 ok"
assert_eq "site.drift" data.drift false
assert_eq "site.custom" data.custom false
j get "$RESP" data.raw > "$WORK/snippet.raw"
grep -Fq -- '# 由 ext-caddy-manage 生成；可在面板「配置文件」中编辑。' "$WORK/snippet.raw" \
  || fail "片段缺少生成注释"
grep -Fq -- 'http://e2e.local {' "$WORK/snippet.raw" || fail "片段缺少 http 地址行"
grep -Fq -- $'\tencode zstd gzip' "$WORK/snippet.raw" || fail "片段缺少 encode 指令"
grep -Fq -- $'\tlog' "$WORK/snippet.raw" || fail "片段缺少 log 指令"
grep -Fq -- "root * \"$SITE_DIR\"" "$WORK/snippet.raw" || fail "片段根目录不正确"
grep -Fq -- 'try_files {path} /index.html' "$WORK/snippet.raw" || fail "片段缺少 SPA 回退"
grep -Fq -- $'\tfile_server' "$WORK/snippet.raw" || fail "片段缺少 file_server"
[[ -f "$SNIPPET_DIR/$SLUG.caddy" ]] || fail "启用目录中缺少片段文件"
cmp -s "$WORK/snippet.raw" "$SNIPPET_DIR/$SLUG.caddy" || fail "API 原文与磁盘文件不一致"
[[ $(stat -c '%a' "$SNIPPET_DIR/$SLUG.caddy") == "644" ]] || fail "片段文件权限不是 0644"

# ---------------------------------------------------------------- 校验与重载

say "校验片段与整体配置，然后重载"
python3 - "$WORK/body.json" "$WORK/snippet.raw" <<'PY'
import json
import sys

json.dump({"content": open(sys.argv[2], encoding="utf-8").read()},
          open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /site/validate "$WORK/body.json"
assert_status 200 "片段校验请求失败"
assert_ok "片段校验未返回 ok"
assert_eq "片段校验有效" data.valid true

printf '{}\n' > "$WORK/body.json"
http_call POST /config/validate "$WORK/body.json"
assert_status 200 "整体校验请求失败"
assert_ok "整体校验未返回 ok"
assert_eq "整体校验有效" data.valid true
assert_eq "整体校验来源" data.source "current"

printf '{}\n' > "$WORK/body.json"
http_call POST /service/reload "$WORK/body.json"
assert_status 200 "重载失败"
assert_ok "重载未返回 ok"
assert_eq "重载前校验" data.validate.ok true
assert_eq "重载结果" data.reload.ok true

# ---------------------------------------------------------------- HTTP 命中

say "通过 Host 头请求站点"
HTTP_BODY=""
for _ in $(seq 1 50); do
  if HTTP_BODY=$(curl --noproxy '*' -fsS --max-time 3 -H 'Host: e2e.local' \
      "http://127.0.0.1:$HTTP_PORT/"); then
    break
  fi
  sleep 0.2
done
[[ "$HTTP_BODY" == *"e2e-static-ok"* ]] || fail "HTTP 请求未命中站点（响应：$HTTP_BODY）"
say "HTTP 响应正确"

# ---------------------------------------------------------------- 本机反代

say "创建本机反代并验证回环监听、请求转发和地址冲突"
python3 - "$WORK/body.json" "$PROXY_PORT" "$HTTP_PORT" <<'PY'
import json
import sys

path, proxy_port, upstream_port = sys.argv[1:]
model = {
    "name": "E2E loopback proxy",
    "type": "proxy",
    "domains": [f"127.0.0.1:0{proxy_port}", f"localhost:{proxy_port}"],
    "https": True,
    "proxy": {"upstreams": [f"127.0.0.1:{upstream_port}"], "hostHeader": "e2e.local"},
}
with open(path, "w", encoding="utf-8") as body:
    json.dump({"model": model}, body)
PY
http_call POST /site "$WORK/body.json"
assert_status 200 "创建本机反代失败"
assert_eq "本机反代已重载" data.apply.reloaded true
assert_eq "本机端口规范化" data.model.domains.0 "127.0.0.1:$PROXY_PORT"
assert_eq "本机反代没有证书" data.certs '[]'
PROXY_SLUG=$(j get "$RESP" data.slug)
j get "$RESP" data.raw > "$WORK/proxy.raw"
grep -Fq -- "http://127.0.0.1:$PROXY_PORT, http://localhost:$PROXY_PORT {" "$WORK/proxy.raw" \
  || fail "本机反代缺少 HTTP 地址"
grep -Fxq -- $'\tbind 127.0.0.1' "$WORK/proxy.raw" || fail "本机反代未绑定到回环地址"
for host in "127.0.0.1" "localhost"; do
  HTTP_BODY=$(curl --noproxy '*' -fsS --max-time 3 -H "Host: $host:$PROXY_PORT" \
    "http://127.0.0.1:$PROXY_PORT/") || fail "请求本机反代失败：$host"
  [[ "$HTTP_BODY" == *"e2e-static-ok"* ]] || fail "本机反代响应不正确：$host"
done

http_call POST /site "$WORK/body.json"
assert_status 409 "重复的本机站点地址应冲突"
assert_error "本机站点地址冲突错误码" conflict

say "通过表单改为监听所有 IPv4 网卡"
http_call GET "/site?slug=$PROXY_SLUG"
assert_status 200 "读取本机反代失败"
python3 - "$RESP" "$WORK/body.json" "$PROXY_PORT" <<'PY'
import json
import sys

response, path, proxy_port = sys.argv[1:]
with open(response, encoding="utf-8") as source:
    site = json.load(source)["data"]
site["model"]["domains"] = [f"0.0.0.0:0{proxy_port}"]
with open(path, "w", encoding="utf-8") as body:
    json.dump({"slug": site["slug"], "baseline": site["raw"], "model": site["model"]}, body)
PY
http_call POST /site/update "$WORK/body.json"
assert_status 200 "保存 IPv4 通配监听失败"
assert_eq "IPv4 通配端口规范化" data.model.domains.0 "0.0.0.0:$PROXY_PORT"
assert_eq "IPv4 通配监听没有证书" data.certs '[]'
assert_eq "IPv4 通配监听已重载" data.apply.reloaded true
j get "$RESP" data.raw > "$WORK/proxy.raw"
grep -Fxq -- "http://:$PROXY_PORT {" "$WORK/proxy.raw" || fail "IPv4 通配监听限制了 Host"
grep -Fxq -- $'\tbind 0.0.0.0' "$WORK/proxy.raw" || fail "未监听所有 IPv4 网卡"
HTTP_BODY=$(curl --noproxy '*' -fsS --max-time 3 -H "Host: 192.0.2.10:$PROXY_PORT" \
  "http://127.0.0.1:$PROXY_PORT/") || fail "IPv4 通配监听未接受局域网 Host"
[[ "$HTTP_BODY" == *"e2e-static-ok"* ]] || fail "IPv4 通配监听响应不正确"
grep -Fq -- "\"logger\":\"http.log.access.ecm-ipv4-$PROXY_PORT\"" "$WORK/logs/caddy.log" \
  || fail "IPv4 通配监听的访问日志缺少监听端口标识"

python3 - "$WORK/body.json" "$PROXY_SLUG" "$WORK/proxy.raw" <<'PY'
import json
import sys

path, slug, raw = sys.argv[1:]
with open(path, "w", encoding="utf-8") as body, open(raw, encoding="utf-8") as baseline:
    json.dump({"slug": slug, "baseline": baseline.read()}, body)
PY
http_call POST /site/delete "$WORK/body.json"
assert_status 200 "清理本机反代失败"

# ---------------------------------------------------------------- 表单修改

say "表单修改（改名、目录浏览、关闭 SPA、添加响应头）"
http_call GET "/site?slug=$SLUG"
assert_status 200 "读取站点详情失败"
j getjson "$RESP" data.model > "$WORK/model.json"
j get "$RESP" data.raw > "$WORK/baseline.txt"
export MODEL_FILE="$WORK/model.json"
export BASELINE_FILE="$WORK/baseline.txt"

python3 - "$WORK/body.json" <<'PY'
import json
import os
import sys

model = json.load(open(os.environ["MODEL_FILE"], encoding="utf-8"))
model["name"] = "E2E Static v2"
model["static"]["browse"] = True
model["static"]["spa"] = False
model["security"]["headers"] = [{"name": "X-E2E", "value": "yes"}]
json.dump({
    "slug": os.environ["SLUG"],
    "model": model,
    "baseline": open(os.environ["BASELINE_FILE"], encoding="utf-8").read(),
}, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
PY
http_call POST /site/preview "$WORK/body.json"
assert_status 200 "预览站点表单失败"
assert_ok "站点表单预览未返回 ok"
j get "$RESP" data.content > "$WORK/snippet-preview.raw"
cmp -s "$WORK/baseline.txt" "$SNIPPET_DIR/$SLUG.caddy" || fail "预览不应修改站点片段"
http_call POST /site/update "$WORK/body.json"
assert_status 200 "表单保存失败"
assert_ok "表单保存未返回 ok"
assert_eq "表单保存名称" data.model.name "E2E Static v2"
assert_eq "表单保存 browse" data.model.static.browse true
assert_eq "表单保存已重载" data.apply.reloaded true
assert_eq "表单与磁盘内容一致" data.formMatchesFile true
j get "$RESP" data.raw > "$WORK/snippet-v2.raw"
cmp -s "$WORK/snippet-preview.raw" "$WORK/snippet-v2.raw" || fail "预览与表单保存的内容不一致"
grep -Fq -- $'\tfile_server browse' "$WORK/snippet-v2.raw" || fail "browse 未生成"
grep -Fq -- '"X-E2E" "yes"' "$WORK/snippet-v2.raw" || fail "自定义响应头未生成"
if grep -Fq -- 'try_files' "$WORK/snippet-v2.raw"; then
  fail "关闭 SPA 后仍生成 try_files"
fi

# ---------------------------------------------------------------- 原文保存与冲突

say "原文保存站点片段"
cp "$WORK/snippet-v2.raw" "$WORK/raw-with-marker.raw"
printf '# e2e-raw-marker\n' >> "$WORK/raw-with-marker.raw"
python3 - "$WORK/body.json" "$WORK/raw-with-marker.raw" "$WORK/snippet-v2.raw" <<'PY'
import json
import os
import sys

json.dump({
    "slug": os.environ["SLUG"],
    "content": open(sys.argv[2], encoding="utf-8").read(),
    "baseline": open(sys.argv[3], encoding="utf-8").read(),
    "force": False,
}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /site/raw "$WORK/body.json"
assert_status 200 "原文保存失败"
assert_ok "原文保存未返回 ok"
assert_eq "原文保存已重载" data.apply.reloaded true
assert_eq "原文保存 drift" data.drift false
assert_eq "原文与表单生成结果不同" data.formMatchesFile false
j get "$RESP" data.raw > "$WORK/snippet-v3.raw"
cmp -s "$WORK/raw-with-marker.raw" "$WORK/snippet-v3.raw" || fail "原文保存内容不一致"
grep -Fq -- '# e2e-raw-marker' "$SNIPPET_DIR/$SLUG.caddy" || fail "磁盘片段缺少原文标记"

say "冲突检测（过期基线应返回 409）"
python3 - "$WORK/body.json" "$WORK/snippet-v3.raw" <<'PY'
import json
import os
import sys

json.dump({
    "slug": os.environ["SLUG"],
    "content": open(sys.argv[2], encoding="utf-8").read(),
    "baseline": "stale-baseline",
    "force": False,
}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /site/raw "$WORK/body.json"
assert_status 409 "过期基线未返回 409"
assert_error "冲突错误码不是 conflict" conflict
cmp -s "$WORK/snippet-v3.raw" "$SNIPPET_DIR/$SLUG.caddy" || fail "冲突请求不应修改文件"

# ---------------------------------------------------------------- 停用 / 启用

say "停用站点"
http_call GET "/site?slug=$SLUG"
assert_status 200 "停用前读取站点失败"
assert_ok "停用前站点详情未返回 ok"
j get "$RESP" data.raw > "$WORK/baseline.txt"
python3 - "$WORK/body.json" <<'PY'
import json
import os
import sys

json.dump({
    "slug": os.environ["SLUG"],
    "baseline": open(os.environ["BASELINE_FILE"], encoding="utf-8").read(),
}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /site/disable "$WORK/body.json"
assert_status 200 "停用失败"
assert_ok "停用未返回 ok"
assert_eq "停用后 enabled" data.enabled false
assert_eq "停用已重载" data.apply.reloaded true
[[ ! -e "$SNIPPET_DIR/$SLUG.caddy" ]] || fail "停用后启用目录仍存在片段"
[[ -f "$DISABLED_DIR/$SLUG.caddy" ]] || fail "停用目录缺少片段"
cmp -s "$WORK/snippet-v3.raw" "$DISABLED_DIR/$SLUG.caddy" || fail "停用后的片段内容不一致"

say "重新启用站点"
python3 - "$WORK/body.json" <<'PY'
import json
import os
import sys

json.dump({"slug": os.environ["SLUG"]}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /site/enable "$WORK/body.json"
assert_status 200 "启用失败"
assert_ok "启用未返回 ok"
assert_eq "启用后 enabled" data.enabled true
assert_eq "启用已重载" data.apply.reloaded true
[[ -f "$SNIPPET_DIR/$SLUG.caddy" ]] || fail "启用后启用目录缺少片段"
[[ ! -e "$DISABLED_DIR/$SLUG.caddy" ]] || fail "启用后停用目录仍有片段"

HTTP_BODY=""
for _ in $(seq 1 50); do
  if HTTP_BODY=$(curl --noproxy '*' -fsS --max-time 3 -H 'Host: e2e.local' \
      "http://127.0.0.1:$HTTP_PORT/"); then
    break
  fi
  sleep 0.2
done
[[ "$HTTP_BODY" == *"e2e-static-ok"* ]] || fail "重新启用后 HTTP 未命中站点"

# ---------------------------------------------------------------- 删除

say "删除站点（应保留站点目录）"
http_call GET "/site?slug=$SLUG"
assert_status 200 "删除前读取站点失败"
assert_ok "删除前站点详情未返回 ok"
j get "$RESP" data.raw > "$WORK/baseline.txt"
python3 - "$WORK/body.json" <<'PY'
import json
import os
import sys

json.dump({
    "slug": os.environ["SLUG"],
    "baseline": open(os.environ["BASELINE_FILE"], encoding="utf-8").read(),
}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /site/delete "$WORK/body.json"
assert_status 200 "删除失败"
assert_ok "删除未返回 ok"
assert_eq "deleted" data.deleted true
assert_eq "删除已重载" data.apply.reloaded true
[[ ! -e "$SNIPPET_DIR/$SLUG.caddy" ]] || fail "删除后启用目录仍有片段"
[[ ! -e "$DISABLED_DIR/$SLUG.caddy" ]] || fail "删除后停用目录仍有片段"
[[ -d "$SITE_DIR" ]] || fail "删除站点后站点目录应保留"

http_call GET "/site?slug=$SLUG"
assert_status 404 "删除后站点详情应返回 404"
assert_error "删除后错误码" not_found

# ---------------------------------------------------------------- 备份恢复

say "备份列表与恢复"
http_call GET "/backups?scope=site&limit=100"
assert_status 200 "读取备份列表失败"
assert_ok "备份列表未返回 ok"
python3 - "$RESP" "$SLUG" "$WORK/backup-name.txt" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))["data"]
target = sys.argv[2] + ".caddy"
names = [item["name"] for item in data.get("items", []) if item.get("target") == target]
if not names:
    sys.exit("没有找到该站点的备份")
open(sys.argv[3], "w", encoding="utf-8").write(names[0])
PY
BACKUP_NAME=$(cat "$WORK/backup-name.txt")
[[ -n "$BACKUP_NAME" ]] || fail "备份名称为空"
export BACKUP_NAME
BACKUP_FILE="$WORK/host-data/plugins/de.jianwang.caddy-manage/data/backups/$BACKUP_NAME"
[[ -f "$BACKUP_FILE" ]] || fail "备份文件不存在：$BACKUP_FILE"
[[ $(stat -c '%a' "$BACKUP_FILE") == "600" ]] || fail "备份文件权限不是 0600"
[[ $(stat -c '%a' "$(dirname "$BACKUP_FILE")") == "700" ]] || fail "备份目录权限不是 0700"

python3 - "$WORK/body.json" <<'PY'
import json
import os
import sys

json.dump({"name": os.environ["BACKUP_NAME"]}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /backup/restore "$WORK/body.json"
assert_status 200 "恢复备份失败"
assert_ok "恢复备份未返回 ok"
assert_eq "恢复 scope" data.scope "site"
assert_eq "恢复后 enabled" data.enabled true
assert_eq "恢复已重载" data.apply.reloaded true
[[ -f "$SNIPPET_DIR/$SLUG.caddy" ]] || fail "恢复后片段文件不存在"

http_call GET "/site?slug=$SLUG"
assert_status 200 "恢复后读取站点失败"
assert_ok "恢复后站点详情未返回 ok"
assert_eq "恢复后 custom" data.custom true
j get "$RESP" data.raw > "$WORK/restored.raw"
cmp -s "$WORK/snippet-v3.raw" "$WORK/restored.raw" || fail "恢复内容与备份不一致"
grep -Fq -- '# e2e-raw-marker' "$WORK/restored.raw" || fail "恢复内容缺少原文标记"
HTTP_BODY=""
for _ in $(seq 1 50); do
  if HTTP_BODY=$(curl --noproxy '*' -fsS --max-time 3 -H 'Host: e2e.local' \
      "http://127.0.0.1:$HTTP_PORT/"); then
    break
  fi
  sleep 0.2
done
[[ "$HTTP_BODY" == *"e2e-static-ok"* ]] || fail "恢复备份后 HTTP 未命中站点（响应：$HTTP_BODY）"

# ---------------------------------------------------------------- fmt

say "格式化候选配置（caddy fmt）"
python3 - "$WORK/body.json" <<'PY'
import json
import sys

json.dump({"content": "e2e.local {\nlog\n}\n"}, open(sys.argv[1], "w", encoding="utf-8"))
PY
http_call POST /config/fmt "$WORK/body.json"
assert_status 200 "格式化请求失败"
assert_ok "格式化未返回 ok"
assert_eq "格式化 changed" data.changed true
j get "$RESP" data.formatted > "$WORK/formatted.txt"
grep -Fq -- $'\tlog' "$WORK/formatted.txt" || fail "格式化结果缺少缩进"

# ---------------------------------------------------------------- 可选 systemd

SYSTEMD_CHECKED=0
if [[ "$E2E_SYSTEMD" == 1 ]]; then
  say "E2E_SYSTEMD=1：读取 systemd 服务状态"
  if systemctl cat caddy.service >/dev/null 2>&1; then
    http_call GET /service
    assert_status 200 "读取服务状态失败"
    if [[ "$(j get "$RESP" data.available)" == "true" ]]; then
      assert_eq "service.unit" data.unit "caddy.service"
      SYSTEMD_CHECKED=1
      say "systemd 服务读取正常"
    else
      skip "caddy.service 不可用：检查 systemd 与宿主账号的读取权限"
    fi
  else
    skip "未安装 caddy.service"
  fi
else
  skip "服务 start/stop/logs、证书探测与部署权限需要真实 systemd/域名，见 docs/design.md §14.2；设置 E2E_SYSTEMD=1 可加测服务读取"
fi

if [[ "$SYSTEMD_CHECKED" == 1 ]]; then
  say "PASS: ext-caddy-manage e2e 全部通过（含 systemd 读取检查）"
elif [[ "$E2E_SYSTEMD" == 1 ]]; then
  say "PASS: ext-caddy-manage e2e 基础流程通过（systemd 集成检查已跳过）"
else
  say "PASS: ext-caddy-manage e2e 基础流程通过（systemd/证书等手工项按设计跳过）"
fi
exit 0
