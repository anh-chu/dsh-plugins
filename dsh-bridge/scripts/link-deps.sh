#!/usr/bin/env bash
# 把本机 dsh 携带的官方包链接进本插件的 node_modules，供单测解析 @deepseek-ai/* 使用。
#
# 上游 dsh-bridge 没有构建步骤（lib/index.js 就是源码），这里只需要能让
# test/bridge.test.mjs 与 test/compat-0.2.cjs 解析到官方包。
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

PKGS=(cordis dsh-agent dsh-llm dsh-session dsh-tools schemastery)

mkdir -p node_modules/@deepseek-ai
for p in "${PKGS[@]}"; do
  src="$B/$p"
  if [ ! -d "$src" ]; then
    echo "跳过（本机 dsh 未分发）：$p" >&2
    continue
  fi
  ln -sfn "$src" "node_modules/@deepseek-ai/$p"
done
ln -sfn "$B/dsh-session-format-v3-to-v4" "node_modules/@deepseek-ai/dsh-session-format-v3-to-v4"
echo "已链接官方包 -> node_modules/@deepseek-ai"
