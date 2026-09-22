@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   GKD 规则合并工具 (merge_gkd.cjs)
echo ========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js, 请先安装: https://nodejs.org/
    echo        安装后重新双击本文件即可。
    echo.
    pause
    exit /b 1
)
"C:\Program Files\nodejs\node" merge_gkd.cjs %*
echo.
pause
