#!/usr/bin/env bash
# Install (or remove) the Blade Vale backend as a 24/7 launchd agent on macOS, so the living
# world keeps warring without you running `npm run server` by hand.
#   bash server/install-launchd.sh install
#   bash server/install-launchd.sh uninstall
set -euo pipefail
LABEL="com.bladevale.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOG="$PROJECT/server/launchd.log"

case "${1:-install}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$PROJECT/server/index.js</string></array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key><dict><key>BV_PORT</key><string>8787</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF
    plutil -lint "$PLIST"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed + loaded $LABEL — server runs 24/7 on :8787 (log: $LOG)"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    ;;
  *) echo "usage: $0 install|uninstall"; exit 1 ;;
esac
