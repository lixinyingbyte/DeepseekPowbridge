#!/usr/bin/env bash
# 一键启动脚本（macOS / Linux）
# 首次运行会复制 config.example.json -> config.json 并提示填写凭据
set -e
cd "$(dirname "$0")"

echo
echo "  ================================================"
echo "    DSX Proxy - DeepSeek 本地 OpenAI 代理"
echo "  ================================================"
echo

# 1. 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "  [X] 没找到 node，请先安装 Node.js 18 或更高版本"
  echo "      https://nodejs.org/"
  exit 1
fi
echo "  [OK] Node.js $(node -v)"

# 2. 配置文件
if [ ! -f config.json ]; then
  if [ -f config.example.json ]; then
    cp config.example.json config.json
    echo "  [OK] 已生成 config.json"
    echo
    echo "  下一步：编辑 config.json，填入下面两个值："
    echo "      creds.bearer    —— 抓包得到的 Authorization（去掉 Bearer 前缀）"
    echo "      creds.deviceId  —— 抓包得到的 x-device-id"
    echo
    ${EDITOR:-vi} config.json
    echo "  填好后重新运行本脚本。"
    exit 0
  else
    echo "  [X] 缺少 config.example.json"
    exit 1
  fi
fi
echo "  [OK] 配置文件 config.json 存在"

# 3. 凭据检查
if grep -q '"bearer": ""' config.json; then
  echo
  echo "  [!] config.json 里的 creds.bearer 还是空的"
  echo "      现在打开编辑器给你填..."
  ${EDITOR:-vi} config.json
  exit 0
fi

# 4. 自检
node src/index.js --self-test

# 5. 启动
echo
echo "  ================================================"
echo "    启动中... 按 Ctrl+C 停止"
echo "  ================================================"
echo
exec node src/index.js
