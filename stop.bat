@echo off
echo Deteniendo ClipShare...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9977 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
    echo Proceso terminado (PID %%a).
)
echo Listo.
pause
