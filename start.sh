#!/usr/bin/env sh
# Twitch Highlight Recorder: start on macOS / Linux. Installs dependencies on the first run.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 22+ (https://nodejs.org) и запустите скрипт ещё раз."
  exit 1
fi
command -v streamlink >/dev/null 2>&1 || echo "[!] Streamlink не найден в PATH (или укажите путь в «Настройках»)"
command -v ffmpeg >/dev/null 2>&1 || echo "[!] FFmpeg не найден в PATH (или укажите путь в «Настройках»)"

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю зависимости…"
  npm install
fi

exec npm start
