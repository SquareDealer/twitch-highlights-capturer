@echo off
rem Twitch Highlight Recorder: double-click to start. Installs dependencies on the first run.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите его командой:  winget install OpenJS.NodeJS.LTS
  echo и запустите этот файл ещё раз.
  pause
  exit /b 1
)

where streamlink >nul 2>nul
if errorlevel 1 echo [!] Streamlink не найден в PATH: winget install streamlink  ^(или укажите путь в «Настройках»^)
where ffmpeg >nul 2>nul
if errorlevel 1 echo [!] FFmpeg не найден в PATH: winget install Gyan.FFmpeg  ^(или укажите путь в «Настройках»^)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости, это займёт минуту...
  call npm install
  if errorlevel 1 (
    echo Не удалось установить зависимости.
    pause
    exit /b 1
  )
)

call npm start
pause
