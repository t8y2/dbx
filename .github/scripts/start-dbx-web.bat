@echo off
setlocal EnableDelayedExpansion

for %%A in (%*) do (
    if /I "%%~A"=="-h" goto :help
    if /I "%%~A"=="--help" goto :help
    if /I "%%~A"=="/help" goto :help
)
goto :main

:help
echo Usage: start.bat [OPTION]
echo.
echo Start the DBX Web browser service.
echo.
echo Options:
echo   -h, --help, /help  Show this help message and exit.
echo.
echo Environment variables:
echo   DBX_PORT              Listen port (default: 4224)
echo   DBX_DATA_DIR          Data directory (default: package-dir\data)
echo   DBX_PUBLIC_BASE_PATH  URL path prefix (default: /)
echo   DBX_PASSWORD          Set the Web login password
echo   DBX_DISABLE_PASSWORD  Set to 1 to disable login protection
echo   RUST_LOG              Configure backend log filtering
echo   RUST_BACKTRACE        Set to 1 to include Rust backtraces
echo.
echo Examples:
echo   set DBX_PORT=8080 ^&^& start.bat
echo   set RUST_LOG=dbx_web=debug,tower_http=info ^&^& start.bat
exit /b 0

:main

:: 脚本所在目录（等价于 ROOT）
set ROOT=%~dp0
:: 去掉末尾反斜杠
set ROOT=%ROOT:~0,-1%

set DBX_PACKAGE_ROOT=%ROOT%

:: static dir
if "%DBX_STATIC_DIR%"=="" (
    :: dist静态资源文件已直接嵌入到二进制文件中，环境变量中没有设置的话，直接用二进制中的静态文件
    rem set DBX_STATIC_DIR=%ROOT%\dist
)
:: data dir
if "%DBX_DATA_DIR%"=="" (
    set DBX_DATA_DIR=%ROOT%\data
)

:: port
if "%DBX_PORT%"=="" (
    set DBX_PORT=4224
)

:: base path
set BASE_PATH=%DBX_PUBLIC_BASE_PATH%
if "%BASE_PATH%"=="" set BASE_PATH=/

:: 如果不是以 / 开头，补上 /
echo %BASE_PATH% | findstr /r "^/" >nul || (
    set BASE_PATH=/!BASE_PATH!
)

echo DBX_DATA_DIR=%DBX_DATA_DIR%
echo DBX browser UI: http://127.0.0.1:%DBX_PORT%%BASE_PATH%

cd /d "%ROOT%"

:: 执行程序
dbx-web.exe %*
