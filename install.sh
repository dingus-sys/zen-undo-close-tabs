#!/bin/bash
# Installs "Undo Close Tabs" as its own local Sine mod.
# Safe to re-run (it also works as an updater for this mod).
# Zen must be closed: Sine rewrites mods.json while it is running.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILES="$HOME/Library/Application Support/zen/Profiles"

if pgrep -x zen >/dev/null; then
  echo "Zen is running. Quit it (Cmd+Q) and run this again." >&2
  exit 1
fi

# Profile: pass as $1, otherwise the first one that has Sine installed.
PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
  for d in "$PROFILES"/*/; do
    if [ -f "$d/chrome/sine-mods/mods.json" ]; then PROFILE="${d%/}"; break; fi
  done
fi
if [ -z "$PROFILE" ] || [ ! -f "$PROFILE/chrome/sine-mods/mods.json" ]; then
  echo "Couldn't find a Zen profile with Sine. Pass the profile folder as the first argument." >&2
  exit 1
fi

MODS_DIR="$PROFILE/chrome/sine-mods"
DEST="$MODS_DIR/undo-close-tabs"
mkdir -p "$DEST"
cp "$HERE/undo-close-tabs.uc.js" "$HERE/preferences.json" "$DEST/"

cp "$MODS_DIR/mods.json" "$MODS_DIR/mods.json.bak-undo-close"
python3 - "$MODS_DIR/mods.json" <<'EOF'
import json, sys
path = sys.argv[1]
mods = json.load(open(path))
prev = mods.get("undo-close-tabs", {})
mods["undo-close-tabs"] = {
    "id": "undo-close-tabs",
    "name": "Undo Close Tabs",
    "description": "Cmd+Z restores the tab you just closed, or everything removed by Clear.",
    "author": "local",
    "version": "1.0.0",
    "scripts": {
        "undo-close-tabs.uc.js": {
            "include": ["chrome://browser/content/browser.xhtml"],
            "loadOrder": 50,
        }
    },
    "style": {"chrome": "", "content": ""},
    "preferences": "preferences.json",
    "fork": ["zen"],
    "no-updates": True,  # local mod: Sine has no upstream to update it from
    "enabled": prev.get("enabled", True),
}
json.dump(mods, open(path, "w"), separators=(",", ":"))
print("Registered mod in mods.json (backup: mods.json.bak-undo-close)")
EOF

echo "Installed to: $DEST"
echo "Done. Start Zen: Cmd+Z now restores closed tabs (settings are under the mod's preferences)."
