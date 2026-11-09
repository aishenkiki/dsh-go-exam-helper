#!/bin/sh
# 一条命令发版：自检 → 测试 → npm 发布 → GitHub 同步 → 装回本机
# 用法：sh tools/release.sh [--no-install]
set -e
cd "$(dirname "$0")/.."

VER=$(node -p "require('./package.json').version")
echo "== 发版 $VER"

echo "== 1/5 预检"
node tools/preflight.mjs | tail -3

echo "== 2/5 单测"
cd /root/workspace/exam-helper
cp /root/workspace/exam-helper-pkg/payload/lib/*.mjs lib/ 2>/dev/null || true
node --test test/*.test.mjs 2>&1 | tail -5
cd /root/workspace/exam-helper-pkg

echo "== 3/5 发布到 npm"
npm publish --registry=https://registry.npmjs.org \
  --userconfig=/root/.dsh/secrets/npmrc --access public 2>&1 | tail -3

echo "== 4/5 等 registry 同步"
i=0
while [ $i -lt 20 ]; do
  got=$(npm view dsh-go-exam-helper version --registry=https://registry.npmjs.org 2>/dev/null || echo "")
  [ "$got" = "$VER" ] && break
  i=$((i + 1)); sleep 15
done
[ "$got" = "$VER" ] || { echo "!! registry 仍是 $got，稍后重试"; exit 1; }

echo "== 5/5 同步 GitHub 并装回本机"
node tools/sync-github.mjs "$VER"

if [ "$1" != "--no-install" ]; then
  dsh plugin --profile web remove dsh-go-exam-helper >/dev/null 2>&1 || true
  dsh plugin --profile web add "dsh-go-exam-helper@$VER" 2>&1 | tail -2
  echo "== 运行目录版本：$(cat /root/.dsh/dsh-go/exam-helper/VERSION 2>/dev/null || echo 未部署)"
fi

echo "== 完成 $VER"
