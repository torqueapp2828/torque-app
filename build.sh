#!/bin/bash

# ─── Torque Build Script v2.0 ─────────────────────────────────────────────────
# Usage:
#   ./build.sh          → interactive JSX picker + builds APK
#   ./build.sh --web    → builds web only (no APK)
#   ./build.sh --clean  → wipes android/ and rebuilds from scratch
#   ./build.sh --help   → show help

set -e

# ─── Config ───────────────────────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$PROJECT_DIR/src"
APP_TARGET="$SRC_DIR/App.jsx"
APK_SOURCE="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
APK_DEST="$PROJECT_DIR/torque-latest.apk"

# ─── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
GOLD='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

log()     { echo -e "${GOLD}[Torque]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info()    { echo -e "${BLUE}[i]${NC} $1"; }

# ─── Header ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GOLD}  ████████╗ ██████╗ ██████╗  ██████╗ ██╗   ██╗███████╗${NC}"
echo -e "${GOLD}     ██╔══╝██╔═══██╗██╔══██╗██╔═══██╗██║   ██║██╔════╝${NC}"
echo -e "${GOLD}     ██║   ██║   ██║██████╔╝██║   ██║██║   ██║█████╗  ${NC}"
echo -e "${GOLD}     ██║   ██║   ██║██╔══██╗██║▄▄ ██║██║   ██║██╔══╝  ${NC}"
echo -e "${GOLD}     ██║   ╚██████╔╝██║  ██║╚██████╔╝╚██████╔╝███████╗${NC}"
echo -e "${GOLD}     ╚═╝    ╚═════╝ ╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚══════╝${NC}"
echo ""
echo -e "${GOLD}  Build Script v2.0${NC}"
echo ""

# ─── Parse Args ───────────────────────────────────────────────────────────────
WEB_ONLY=false
CLEAN=false

for arg in "$@"; do
  case $arg in
    --web)   WEB_ONLY=true ;;
    --clean) CLEAN=true ;;
    --help)
      echo "Usage: ./build.sh [options]"
      echo ""
      echo "  (no args)   Interactive JSX picker + build APK"
      echo "  --web       Build web only, skip APK"
      echo "  --clean     Wipe android/ and rebuild from scratch"
      echo "  --help      Show this help"
      echo ""
      exit 0
      ;;
  esac
done

cd "$PROJECT_DIR"

# ─── JSX File Picker ──────────────────────────────────────────────────────────
echo -e "${CYAN}  Select the JSX file to build:${NC}"
echo ""

# Find all .jsx files, excluding node_modules / android / .git
mapfile -t JSX_FILES < <(find "$PROJECT_DIR" \
  -maxdepth 2 \
  -name "*.jsx" \
  -not -path "*/node_modules/*" \
  -not -path "*/android/*" \
  -not -path "*/.git/*" \
  | sort)

if [ ${#JSX_FILES[@]} -eq 0 ]; then
  error "No .jsx files found. Place your file in the project root or src/."
fi

# Display numbered list
for i in "${!JSX_FILES[@]}"; do
  FNAME="${JSX_FILES[$i]}"
  REL="${FNAME#$PROJECT_DIR/}"
  if [ "$FNAME" = "$APP_TARGET" ]; then
    echo -e "  ${GREEN}$((i+1)))${NC} $REL ${DIM}← current${NC}"
  else
    echo -e "  ${GOLD}$((i+1)))${NC} $REL"
  fi
done

echo ""
echo -ne "${CYAN}  Enter number (or press Enter to keep current src/App.jsx): ${NC}"
read -r SELECTION

if [ -z "$SELECTION" ]; then
  # Keep current App.jsx
  [ -f "$APP_TARGET" ] || error "src/App.jsx not found. Please select a file."
  SELECTED_FILE="$APP_TARGET"
  info "Using current src/App.jsx"
else
  # Validate
  if ! [[ "$SELECTION" =~ ^[0-9]+$ ]] || [ "$SELECTION" -lt 1 ] || [ "$SELECTION" -gt "${#JSX_FILES[@]}" ]; then
    error "Invalid selection. Enter a number between 1 and ${#JSX_FILES[@]}."
  fi
  SELECTED_FILE="${JSX_FILES[$((SELECTION-1))]}"
  REL_SELECTED="${SELECTED_FILE#$PROJECT_DIR/}"

  if [ "$SELECTED_FILE" != "$APP_TARGET" ]; then
    log "Copying $REL_SELECTED → src/App.jsx"
    cp "$SELECTED_FILE" "$APP_TARGET"
    success "Copied to src/App.jsx"
  else
    info "Selected file is already src/App.jsx"
  fi
fi

echo ""
log "Building: ${SELECTED_FILE#$PROJECT_DIR/}"
echo ""

# ─── Java check ───────────────────────────────────────────────────────────────
log "Checking Java..."
JAVA_VER=$(java -version 2>&1 | head -1)
info "Found: $JAVA_VER"
if ! java -version 2>&1 | grep -q "21\|17"; then
  error "Java 21 not active. Run: sdk use java 21.0.5-tem"
fi
success "Java OK"

# ─── Clean ────────────────────────────────────────────────────────────────────
if [ "$CLEAN" = true ]; then
  log "Wiping android/ folder..."
  rm -rf android/
  success "Cleaned"
fi

# ─── Build web ────────────────────────────────────────────────────────────────
log "Building web app..."
npm run build
success "Web app built → dist/"

if [ "$WEB_ONLY" = true ]; then
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Web build complete.${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  exit 0
fi

# ─── Capacitor sync ───────────────────────────────────────────────────────────
log "Syncing Capacitor..."
if [ ! -d "android" ]; then
  log "No android/ found — running cap add android..."
  npx cap add android
fi
npx cap sync
success "Capacitor synced"

# ─── Build APK ────────────────────────────────────────────────────────────────
log "Building APK..."
cd android
./gradlew assembleDebug --quiet
cd "$PROJECT_DIR"
success "APK built"

# ─── Copy APK ─────────────────────────────────────────────────────────────────
cp "$APK_SOURCE" "$APK_DEST"
APK_SIZE=$(du -sh "$APK_DEST" | cut -f1)
success "APK ready → torque-latest.apk ($APK_SIZE)"

# ─── Auto-install ─────────────────────────────────────────────────────────────
log "Checking for connected device..."
if command -v adb &> /dev/null; then
  DEVICE=$(adb devices | grep -v "List" | grep "device$" | head -1)
  if [ -n "$DEVICE" ]; then
    log "Device found — installing..."
    adb install -r "$APK_DEST"
    success "Installed on device!"
  else
    info "No device connected — skipping auto-install."
    info "To install manually: adb install torque-latest.apk"
  fi
else
  info "adb not found — skipping auto-install."
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Build complete!${NC}"
echo -e "${GREEN}  File: ${SELECTED_FILE#$PROJECT_DIR/}${NC}"
echo -e "${GREEN}  APK:  torque-latest.apk ($APK_SIZE)${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""