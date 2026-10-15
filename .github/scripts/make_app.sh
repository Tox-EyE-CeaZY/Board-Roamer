#!/usr/bin/env bash
# Wraps the macOS binary in BoardRoamer.app and zips it:  make_app.sh <binary> <version> <output.zip>
set -euo pipefail
BIN="$1"; VER="$2"; OUT="$3"
APP="BoardRoamer.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/board-roamer"
chmod +x "$APP/Contents/MacOS/board-roamer"

# icon: the 512 px square, scaled into every size macOS wants
SET="$(mktemp -d)/icon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" android/icon-512.png --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" android/icon-512.png --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Board Roamer</string>
  <key>CFBundleDisplayName</key><string>Board Roamer</string>
  <key>CFBundleIdentifier</key><string>com.boardroamer.app</string>
  <key>CFBundleExecutable</key><string>board-roamer</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VER}</string>
  <key>CFBundleVersion</key><string>${VER}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# an ad-hoc signature: Apple Silicon refuses to run code with none
codesign --force --deep -s - "$APP"
ditto -c -k --keepParent "$APP" "$OUT"
