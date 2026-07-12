@echo off
setlocal

if defined DBX_JAVA_BIN (
    if exist "%DBX_JAVA_BIN%" (
        set "JAVA_BIN=%DBX_JAVA_BIN%"
        goto :run
    )
)

if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\java.exe" (
        set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
        goto :run
    )
)

where java >nul 2>nul
if %errorlevel% equ 0 (
    java -version >nul 2>nul
    if %errorlevel% equ 0 (
        set "JAVA_BIN=java"
        goto :run
    )
)

echo Java runtime not found. Install Java or the optional DBX JDBC runtime. >&2
exit /b 127

:run
"%JAVA_BIN%" -XX:+IgnoreUnrecognizedVMOptions --add-opens=java.base/java.io=ALL-UNNAMED --add-opens=java.base/java.lang=ALL-UNNAMED --add-opens=java.base/java.lang.reflect=ALL-UNNAMED --add-opens=java.base/java.net=ALL-UNNAMED --add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/java.nio.charset=ALL-UNNAMED --add-opens=java.base/java.text=ALL-UNNAMED --add-opens=java.base/java.time=ALL-UNNAMED --add-opens=java.base/java.util=ALL-UNNAMED --add-opens=java.base/java.util.concurrent=ALL-UNNAMED --add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED --add-opens=java.base/jdk.internal.misc=ALL-UNNAMED --add-opens=java.base/jdk.internal.vm=ALL-UNNAMED --add-opens=java.base/sun.nio.ch=ALL-UNNAMED --add-opens=java.base/sun.nio.fs=ALL-UNNAMED --add-opens=java.base/sun.security.action=ALL-UNNAMED --add-opens=java.base/sun.security.ssl=ALL-UNNAMED --add-opens=java.base/sun.security.util=ALL-UNNAMED --add-opens=java.security.jgss/sun.security.jgss=ALL-UNNAMED --add-opens=java.security.jgss/sun.security.krb5=ALL-UNNAMED --add-opens=java.sql/java.sql=ALL-UNNAMED %DBX_JAVA_OPTS% -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -jar "%~dp0..\lib\dbx-jdbc-plugin.jar"
