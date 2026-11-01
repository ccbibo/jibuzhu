#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '記補住 需要 Node.js 24 或更新版本。安裝後再開啟此檔。'
  read -r '?按 Enter 關閉視窗…'
  exit 1
fi
node --experimental-strip-types standalone/server.mjs
result=$?
if [ "$result" -ne 0 ]; then
  echo '啟動未完成。若連接埠已使用，可先關閉另一個 記補住 視窗再試。'
  read -r '?按 Enter 關閉視窗…'
fi
exit "$result"
