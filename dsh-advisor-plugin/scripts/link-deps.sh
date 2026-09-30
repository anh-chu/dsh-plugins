#!/usr/bin/env bash
# 把本机 dsh 携带的官方包链接进本插件的 node_modules，供 tsc 类型检查与单测
# 解析 @deepseek-ai/* 使用。
#
# fork 改动（相对上游）：dsh 安装路径不再硬编码 Homebrew——从 `dsh` 可执行
# 文件的 realpath 反推，Linux/mise 与 macOS/Homebrew 安装都适用。
#
# dsh-client-ui-slots：0.2 起随 CLI 分发，本地链接即可；更早的版本是纯类型包
# （CLI 不分发），此时按当前 dsh 版本从 npm 拉取。
#
# 注意：npm install 会清掉这些链接——装完依赖后重新执行本脚本。
set -euo pipefail
cd "$(dirname "$0")/.."

DSH_BIN="$(readlink -f "$(command -v dsh)")"
B="$(cd "$(dirname "$DSH_BIN")/.." && pwd)/node_modules/@deepseek-ai"
if [ ! -d "$B" ]; then
  echo "找不到官方包目录：$B（dsh realpath = $DSH_BIN）" >&2
  exit 1
fi

PKGS=(
  cordis dsh-agent dsh-commands dsh-llm dsh-session dsh-settings
  dsh-system-prompt dsh-tools schemastery
  dsh-client-locale dsh-client-ui-settings dsh-client-ui-settings-plugins
  dsh-client-connection dsh-client-ui-cordis dsh-client-ui-tool
)

mkdir -p node_modules/@deepseek-ai
for p in "${PKGS[@]}"; do
  if [ ! -d "$B/$p" ]; then
    echo "缺少官方包：$B/$p（请确认 dsh 安装路径）" >&2
    exit 1
  fi
  ln -sfn "$B/$p" "node_modules/@deepseek-ai/$p"
done

# dsh-client-ui-slots：随 CLI 分发就本地链接，否则按版本从 npm 拉
rm -rf node_modules/@deepseek-ai/dsh-client-ui-slots
if [ -d "$B/dsh-client-ui-slots" ]; then
  ln -sfn "$B/dsh-client-ui-slots" "node_modules/@deepseek-ai/dsh-client-ui-slots"
  echo "已链接本地 dsh-client-ui-slots"
else
  DSH_VERSION="$(dsh --version 2>/dev/null || echo 0.1.2-rc.1)"
  TMP="$(mktemp -d)"
  (cd "$TMP" && npm pack "@deepseek-ai/dsh-client-ui-slots@$DSH_VERSION" --silent >/dev/null 2>&1) || true
  TARBALL="$(ls "$TMP"/*.tgz 2>/dev/null | head -1)"
  if [ -n "$TARBALL" ]; then
    mkdir -p node_modules/@deepseek-ai/dsh-client-ui-slots
    tar -xzf "$TARBALL" -C node_modules/@deepseek-ai/dsh-client-ui-slots --strip-components=1
    echo "已从 npm 拉取类型包 dsh-client-ui-slots@$DSH_VERSION"
  else
    echo "警告：CLI 不分发且 npm 未取到 dsh-client-ui-slots，client 半的 tsc 检查会缺类型" >&2
  fi
  rm -rf "$TMP"
fi

echo "已链接 ${#PKGS[@]} 个 @deepseek-ai 包（指向 $B）"
