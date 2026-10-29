#!/usr/bin/env bash
# Regenerates the Android launcher icons and splash screens from resources/logo-mark.svg
# (the Remote mark: family ring + S, petrol accent, camera badge).
# Needs rsvg-convert (librsvg2-bin). Run after changing the logo, then commit the PNGs.
set -euo pipefail
cd "$(dirname "$0")/.."
RES=android/app/src/main/res
BG="#050B14"
MARK=$(sed -e 's/^<svg[^>]*>//' -e 's/<\/svg>$//' resources/logo-mark.svg)

# canvas W H, mark size S (px), corner radius R -> PNG on stdout
render() {
  local w=$1 h=$2 s=$3 r=$4 bg=$5
  local x=$(( (w - s) / 2 )) y=$(( (h - s) / 2 ))
  local fill=""; [ "$bg" != "none" ] && fill="<rect width=\"$w\" height=\"$h\" rx=\"$r\" fill=\"$bg\"/>"
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s">%s<svg x="%s" y="%s" width="%s" height="%s" viewBox="-4 -4 128 128">%s</svg></svg>' \
    "$w" "$h" "$fill" "$x" "$y" "$s" "$s" "$MARK" | rsvg-convert -f png
}

for d in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
  name=${d%%:*}; k=${d##*:}
  px() { python3 -c "print(round($1*$k))"; }
  L=$(px 48); F=$(px 108)
  render "$L" "$L" "$(px 42)" "$(px 10)" "$BG" > "$RES/mipmap-$name/ic_launcher.png"
  render "$L" "$L" "$(px 42)" "$(px 24)" "$BG" > "$RES/mipmap-$name/ic_launcher_round.png"
  # Adaptive foreground: 108dp canvas, mark centred on its ring and inside the 66dp safe zone
  render "$F" "$F" "$(px 68)" 0 none > "$RES/mipmap-$name/ic_launcher_foreground.png"
done

# Splash screens: keep each file's size, dark background, mark centred on its ring
for f in "$RES"/drawable*/splash.png; do
  read -r w h < <(python3 -c "import struct,sys;d=open(sys.argv[1],'rb').read(24);print(*struct.unpack('>II',d[16:24]))" "$f")
  s=$(( (w < h ? w : h) * 28 / 100 ))
  render "$w" "$h" "$s" 0 "$BG" > "$f.tmp" && mv "$f.tmp" "$f"
done

printf '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">%s</color>\n</resources>\n' "$BG" \
  > "$RES/values/ic_launcher_background.xml"
echo "Android icons and splash screens regenerated."
