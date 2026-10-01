#!/bin/bash
# Doble clic para instalar y conectar TradingView con Claude (macOS).
# Si macOS lo bloquea: clic derecho > Abrir.

BRANCH="claude/abrir-tradingview-fl27vh"
REPO="https://github.com/Valen429skate/tradingview-mcp.git"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo " =============================================="
echo "  Instalador TradingView MCP para Claude"
echo " =============================================="
echo ""

fin() { echo ""; read -n 1 -s -r -p "Presiona una tecla para cerrar..."; echo; exit "${1:-0}"; }

# 1. Requisitos
command -v git >/dev/null 2>&1 || { echo " [X] Falta Git. En la Terminal ejecuta: xcode-select --install  (o https://git-scm.com/downloads)"; fin 1; }
command -v node >/dev/null 2>&1 || { echo " [X] Falta Node.js. Instalalo desde https://nodejs.org/ (version LTS)"; fin 1; }
echo " [OK] Git y Node.js encontrados"

# 2. Carpeta del proyecto
if [ -f "$HERE/src/server.js" ]; then DIR="$HERE"; else DIR="$HOME/tradingview-mcp"; fi
if [ -d "$DIR/.git" ]; then
  echo " [..] Actualizando el codigo en $DIR"
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q origin "$BRANCH"
else
  echo " [..] Descargando el codigo en $DIR"
  git clone -q -b "$BRANCH" "$REPO" "$DIR" || { echo " [X] No se pudo descargar. Revisa tu internet."; fin 1; }
fi
echo " [OK] Codigo listo"

# 3. Dependencias
cd "$DIR" || fin 1
echo " [..] Instalando dependencias (puede tardar un minuto)"
npm install --no-fund --no-audit --loglevel=error || { echo " [X] Fallo npm install."; fin 1; }
echo " [OK] Dependencias instaladas"

# 4. Conectar con Claude y verificar
node scripts/setup.js

# 5. Abrir TradingView en modo conexion
echo " [..] Abriendo TradingView en modo conexion (se cerrara y reabrira si ya estaba abierto)"
bash scripts/launch_tv_debug_mac.sh

fin 0
