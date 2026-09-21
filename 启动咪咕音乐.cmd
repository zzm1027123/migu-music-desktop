@echo off
cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" goto :run

echo [1/2] Installing dependencies...
call npm install
if errorlevel 1 goto :err

if exist "node_modules\electron\dist\electron.exe" goto :run

echo [2/2] Downloading Electron runtime...
node fetch-electron.mjs
if errorlevel 1 goto :err
powershell -NoProfile -Command "Expand-Archive -Path '.electron-cache\electron-v44.4.3-win32-x64.zip' -DestinationPath 'node_modules\electron\dist' -Force"
powershell -NoProfile -Command "Set-Content -Path 'node_modules\electron\path.txt' -Value 'electron.exe' -NoNewline"

:run
start "" "node_modules\electron\dist\electron.exe" "."
exit /b 0

:err
echo.
echo Failed to prepare runtime. Run "npm install" manually and retry.
pause
exit /b 1
