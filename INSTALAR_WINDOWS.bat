@echo off
setlocal
title Instalador TradingView MCP
REM Doble clic para instalar y conectar TradingView con Claude.
REM Funciona suelto (lo descarga todo) o dentro de la carpeta del proyecto.

set "BRANCH=claude/abrir-tradingview-fl27vh"
set "REPO=https://github.com/Valen429skate/tradingview-mcp.git"

echo.
echo  ==============================================
echo   Instalador TradingView MCP para Claude
echo  ==============================================
echo.

REM --- 1. Requisitos ---
where git >nul 2>&1 || (echo  [X] Falta Git. Instalalo desde https://git-scm.com/downloads y reinicia la PC. & goto fin)
where node >nul 2>&1 || (echo  [X] Falta Node.js. Instalalo desde https://nodejs.org/ ^(version LTS^) y reinicia la PC. & goto fin)
echo  [OK] Git y Node.js encontrados

REM --- 2. Carpeta del proyecto ---
if exist "%~dp0src\server.js" (
    set "DIR=%~dp0"
) else (
    set "DIR=%USERPROFILE%\tradingview-mcp"
)
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

if exist "%DIR%\.git" (
    echo  [..] Actualizando el codigo en %DIR%
    git -C "%DIR%" fetch -q origin %BRANCH% && git -C "%DIR%" checkout -q %BRANCH% && git -C "%DIR%" pull -q origin %BRANCH%
) else (
    echo  [..] Descargando el codigo en %DIR%
    git clone -q -b %BRANCH% %REPO% "%DIR%" || (echo  [X] No se pudo descargar. Revisa tu internet. & goto fin)
)
echo  [OK] Codigo listo

REM --- 3. Dependencias ---
echo  [..] Instalando dependencias (puede tardar un minuto)
pushd "%DIR%"
call npm install --no-fund --no-audit --loglevel=error || (echo  [X] Fallo npm install. & popd & goto fin)
echo  [OK] Dependencias instaladas

REM --- 4. Conectar con Claude y verificar ---
node scripts\setup.js

REM --- 5. Abrir TradingView en modo conexion ---
echo  [..] Abriendo TradingView en modo conexion (se cerrara y reabrira si ya estaba abierto)
call scripts\launch_tv_debug.bat
popd

:fin
echo.
pause
