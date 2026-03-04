#!/bin/bash

# ─── Torque Icon Generator ────────────────────────────────────────────────────
# Usage:
#   ./generate-icons.sh                     → looks for torque-logo.svg in project root
#   ./generate-icons.sh my-logo.svg         → use a specific SVG file
#   ./generate-icons.sh --help

set -e

# ─── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
GOLD='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${GOLD}[Icons]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info()    { echo -e "${BLUE}[i]${NC} $1"; }

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Header ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GOLD}  Torque Icon Generator${NC}"
echo -e "${GOLD}  ─────────────────────${NC}"
echo ""

# ─── Help ─────────────────────────────────────────────────────────────────────
if [ "$1" = "--help" ]; then
  echo "Usage: ./generate-icons.sh [svg-file]"
  echo ""
  echo "  (no args)       Uses torque-logo.svg in project root"
  echo "  my-logo.svg     Use a specific SVG file"
  echo ""
  echo "Outputs:"
  echo "  public/               → PWA icons (192, 512)"
  echo "  public/               → favicon.svg"
  echo "  android/.../mipmap-*  → Android launcher icons (all densities)"
  echo "  android/.../drawable/ → Splash screen (2732x2732)"
  echo ""
  exit 0
fi

# ─── Locate SVG ───────────────────────────────────────────────────────────────
if [ -n "$1" ]; then
  # User specified a file
  if [[ "$1" = /* ]]; then
    SVG="$1"
  else
    SVG="$PROJECT_DIR/$1"
  fi
else
  # Auto-detect: prefer torque-logo.svg, then any .svg in root
  if [ -f "$PROJECT_DIR/torque-logo.svg" ]; then
    SVG="$PROJECT_DIR/torque-logo.svg"
  else
    mapfile -t SVG_FILES < <(find "$PROJECT_DIR" -maxdepth 1 -name "*.svg" | sort)
    if [ ${#SVG_FILES[@]} -eq 0 ]; then
      error "No SVG file found in project root. Place your logo SVG here or pass it as an argument."
    elif [ ${#SVG_FILES[@]} -eq 1 ]; then
      SVG="${SVG_FILES[0]}"
    else
      # Multiple SVGs — let user pick
      echo -e "${CYAN}  Multiple SVG files found. Select one:${NC}"
      echo ""
      for i in "${!SVG_FILES[@]}"; do
        echo -e "  ${GOLD}$((i+1)))${NC} ${SVG_FILES[$i]##*/}"
      done
      echo ""
      echo -ne "${CYAN}  Enter number: ${NC}"
      read -r SEL
      if ! [[ "$SEL" =~ ^[0-9]+$ ]] || [ "$SEL" -lt 1 ] || [ "$SEL" -gt "${#SVG_FILES[@]}" ]; then
        error "Invalid selection."
      fi
      SVG="${SVG_FILES[$((SEL-1))]}"
    fi
  fi
fi

[ -f "$SVG" ] || error "SVG file not found: $SVG"
info "Source: ${SVG##*/}"
echo ""

# ─── Check Inkscape ───────────────────────────────────────────────────────────
if ! command -v inkscape &> /dev/null; then
  echo -e "${RED}[✗]${NC} Inkscape not found."
  echo ""
  echo "  Install it with:"
  echo -e "  ${GOLD}sudo dnf install inkscape${NC}"
  echo ""
  exit 1
fi
INKSCAPE_VER=$(inkscape --version 2>/dev/null | head -1)
info "Using: $INKSCAPE_VER"
echo ""

# ─── Create output dirs ───────────────────────────────────────────────────────
ANDROID_RES="$PROJECT_DIR/android/app/src/main/res"
PUBLIC="$PROJECT_DIR/public"

mkdir -p "$PUBLIC"
mkdir -p "$ANDROID_RES/mipmap-mdpi"
mkdir -p "$ANDROID_RES/mipmap-hdpi"
mkdir -p "$ANDROID_RES/mipmap-xhdpi"
mkdir -p "$ANDROID_RES/mipmap-xxhdpi"
mkdir -p "$ANDROID_RES/mipmap-xxxhdpi"
mkdir -p "$ANDROID_RES/drawable"
mkdir -p "$ANDROID_RES/drawable-v24"

# ─── Export function ──────────────────────────────────────────────────────────
export_png() {
  local OUT="$1"
  local W="$2"
  local H="$3"
  inkscape "$SVG" \
    --export-type=png \
    --export-filename="$OUT" \
    -w "$W" -h "$H" \
    2>/dev/null
  success "$(basename "$OUT") (${W}×${H})"
}

# ─── PWA Icons ────────────────────────────────────────────────────────────────
log "Generating PWA icons..."
export_png "$PUBLIC/icon-192.png"  192  192
export_png "$PUBLIC/icon-512.png"  512  512
export_png "$PUBLIC/icon-180.png"  180  180   # Apple touch icon
export_png "$PUBLIC/favicon-32.png" 32  32
export_png "$PUBLIC/favicon-16.png" 16  16

# Copy SVG as favicon too
cp "$SVG" "$PUBLIC/favicon.svg"
success "favicon.svg"

echo ""

# ─── Android Launcher Icons ───────────────────────────────────────────────────
log "Generating Android launcher icons..."
export_png "$ANDROID_RES/mipmap-mdpi/ic_launcher.png"       48   48
export_png "$ANDROID_RES/mipmap-hdpi/ic_launcher.png"       72   72
export_png "$ANDROID_RES/mipmap-xhdpi/ic_launcher.png"      96   96
export_png "$ANDROID_RES/mipmap-xxhdpi/ic_launcher.png"     144  144
export_png "$ANDROID_RES/mipmap-xxxhdpi/ic_launcher.png"    192  192

# Round icons (Android 7.1+)
export_png "$ANDROID_RES/mipmap-mdpi/ic_launcher_round.png"     48   48
export_png "$ANDROID_RES/mipmap-hdpi/ic_launcher_round.png"     72   72
export_png "$ANDROID_RES/mipmap-xhdpi/ic_launcher_round.png"    96   96
export_png "$ANDROID_RES/mipmap-xxhdpi/ic_launcher_round.png"   144  144
export_png "$ANDROID_RES/mipmap-xxxhdpi/ic_launcher_round.png"  192  192

echo ""

# ─── Splash Screen ────────────────────────────────────────────────────────────
log "Generating splash screen..."

# Generate a centered logo on dark background for splash
SPLASH_SIZE=2732
SPLASH_LOGO_SIZE=512

# First export a large logo PNG
TEMP_LOGO="/tmp/torque-splash-logo.png"
inkscape "$SVG" --export-type=png --export-filename="$TEMP_LOGO" -w $SPLASH_LOGO_SIZE -h $SPLASH_LOGO_SIZE 2>/dev/null

# Compose splash: dark background + centered logo using ImageMagick if available
if command -v convert &> /dev/null; then
  OFFSET=$(( (SPLASH_SIZE - SPLASH_LOGO_SIZE) / 2 ))
  convert \
    -size ${SPLASH_SIZE}x${SPLASH_SIZE} xc:"#080810" \
    "$TEMP_LOGO" -geometry +${OFFSET}+${OFFSET} -composite \
    "$ANDROID_RES/drawable/splash.png" 2>/dev/null
  cp "$ANDROID_RES/drawable/splash.png" "$ANDROID_RES/drawable-v24/splash.png"
  success "splash.png (${SPLASH_SIZE}×${SPLASH_SIZE}) with dark background"
else
  # Fallback: just use the logo as splash (no background compositing)
  export_png "$ANDROID_RES/drawable/splash.png" $SPLASH_SIZE $SPLASH_SIZE
  cp "$ANDROID_RES/drawable/splash.png" "$ANDROID_RES/drawable-v24/splash.png"
  info "splash.png exported (install ImageMagick for dark background compositing)"
fi

rm -f "$TEMP_LOGO"
echo ""

# ─── Update vite.config for PWA manifest icons ────────────────────────────────
log "Checking vite.config.js..."
VITE_CONFIG="$PROJECT_DIR/vite.config.js"
if [ -f "$VITE_CONFIG" ]; then
  if grep -q "icon-192.png" "$VITE_CONFIG"; then
    success "vite.config.js already references icons — no change needed"
  else
    info "vite.config.js found but doesn't reference icons yet — update manually if needed"
  fi
else
  info "vite.config.js not found — skipping"
fi

echo ""

# ─── Summary ──────────────────────────────────────────────────────────────────
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Icons generated!${NC}"
echo ""
echo -e "  ${CYAN}PWA (public/)${NC}"
echo    "    icon-192.png, icon-512.png, icon-180.png"
echo    "    favicon-16.png, favicon-32.png, favicon.svg"
echo ""
echo -e "  ${CYAN}Android (android/app/src/main/res/)${NC}"
echo    "    mipmap-mdpi/     ic_launcher + ic_launcher_round  (48px)"
echo    "    mipmap-hdpi/     ic_launcher + ic_launcher_round  (72px)"
echo    "    mipmap-xhdpi/    ic_launcher + ic_launcher_round  (96px)"
echo    "    mipmap-xxhdpi/   ic_launcher + ic_launcher_round  (144px)"
echo    "    mipmap-xxxhdpi/  ic_launcher + ic_launcher_round  (192px)"
echo    "    drawable/        splash.png  (2732px)"
echo ""
echo -e "  ${GOLD}Run ./build.sh to build the APK with new icons.${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
