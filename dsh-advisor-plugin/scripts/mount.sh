#!/bin/zsh
# 构建并挂载 dsh-advisor 到本机 DSH 的 web profile（物理拷贝模式，
# 对齐旧 refresh-advisor.sh 工作流；依赖链接指向 brew 安装的 rc.6 包，
# 与运行中的宿主版本精确一致）。
# 挂载后重启 dsh web 生效。
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="$HOME/.dsh/profiles/web"
B="/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"

# 1. 类型检查 + 构建
npm run typecheck >/dev/null
npm run build >/dev/null

# 2. 物理拷贝进 profile 的 node_modules
rm -rf "$PROFILE/node_modules/dsh-advisor"
mkdir -p "$PROFILE/node_modules/dsh-advisor"
cp -R lib src package.json cordis.patch.yml README.md "$PROFILE/node_modules/dsh-advisor/"

# 3. 插件内挂 @deepseek-ai 依赖链接（宿主同版本 rc.6）
mkdir -p "$PROFILE/node_modules/dsh-advisor/node_modules/@deepseek-ai"
for p in cordis dsh-agent dsh-commands dsh-llm dsh-session dsh-settings \
  dsh-system-prompt dsh-tools schemastery; do
  ln -sfn "$B/$p" "$PROFILE/node_modules/dsh-advisor/node_modules/@deepseek-ai/$p"
done

echo "已挂载：$PROFILE/node_modules/dsh-advisor（依赖指向 rc.6：$B）"
echo "重启生效：dsh web"
