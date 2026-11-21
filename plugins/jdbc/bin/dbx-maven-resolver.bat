@echo off
setlocal EnableExtensions DisableDelayedExpansion

if defined DBX_JAVA_BIN (
    if exist "%DBX_JAVA_BIN%" (
        call :check_java "%DBX_JAVA_BIN%"
        if not errorlevel 1 (
            set "JAVA_BIN=%DBX_JAVA_BIN%"
            goto :run
        )
    )
)

if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\java.exe" (
        call :check_java "%JAVA_HOME%\bin\java.exe"
        if not errorlevel 1 (
            set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
            goto :run
        )
    )
)

for /f "delims=" %%J in ('where java 2^>nul') do (
    call :check_java "%%J"
    if not errorlevel 1 (
        set "JAVA_BIN=%%J"
        goto :run
    )
)

echo Java 21 or newer was not found. Install Java or the optional DBX JDBC runtime. >&2
exit /b 127

:check_java
setlocal EnableExtensions EnableDelayedExpansion
set "JAVA_VERSION="
for /f "tokens=3" %%A in ('"%~1" -version 2^>^&1 ^| findstr /I /C:"version"') do if not defined JAVA_VERSION set "JAVA_VERSION=%%~A"
if not defined JAVA_VERSION (endlocal & exit /b 1)
set "JAVA_MAJOR="
for /f "tokens=1,2 delims=." %%A in ("!JAVA_VERSION!") do (
    set "JAVA_MAJOR=%%A"
    if "%%A"=="1" set "JAVA_MAJOR=%%B"
)
if not defined JAVA_MAJOR (endlocal & exit /b 1)
for /f "delims=0123456789" %%A in ("!JAVA_MAJOR!") do (endlocal & exit /b 1)
if !JAVA_MAJOR! GEQ 21 (endlocal & exit /b 0)
endlocal & exit /b 1

:run
"%JAVA_BIN%" -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -cp "%~dp0..\lib\dbx-jdbc-plugin.jar" app.dbx.jdbc.maven.DbxMavenResolver %*
