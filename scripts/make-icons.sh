#!/usr/bin/env bash
# Regenerates every icon of the game from assets/game-logo.png (transparent PNG): web/PWA icons, the logo shown in
# the menu, Android launcher icons and splash screens. The Windows app takes public/icon-512.png (desktop/prepare.mjs).
# Needs ImageMagick:  bash scripts/make-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=assets/game-logo.png
BG='#0b1420'
RES=android/app/src/main/res
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# square transparent master, logo trimmed and centred
convert "$SRC" -trim +repage -background none -gravity center -extent "%[fx:max(w,h)]x%[fx:max(w,h)]" "$TMP/master.png" 2>/dev/null \
  || { s=$(convert "$SRC" -trim +repage -format '%[fx:max(w,h)]' info:); convert "$SRC" -trim +repage -background none -gravity center -extent "${s}x${s}" "$TMP/master.png"; }

logo() { # size, logo share of the size, out [, background]
  local size=$1 share=$2 out=$3 bg=${4:-none}
  local inner; inner=$(awk "BEGIN{printf \"%d\", $size*$share}")
  convert "$TMP/master.png" -filter Lanczos -resize "${inner}x${inner}" -background "$bg" -gravity center -extent "${size}x${size}" -strip "$out"
}
round() { # size, out: launcher icon in a circle
  local size=$1 out=$2
  logo "$size" 0.70 "$TMP/r.png" "$BG"
  convert "$TMP/r.png" \( -size "${size}x${size}" xc:none -fill white -draw "circle $((size/2)),$((size/2)) $((size/2)),0" \) -compose DstIn -composite -strip "$out"
}

logo 384 1 public/icon-game.png                    # menu header / sidebar / boot screen
logo 512 0.84 public/icon-512.png "$BG"
logo 192 0.84 public/icon-192.png "$BG"
logo 180 0.84 public/icon-180.png "$BG"
logo 512 0.62 public/icon-maskable-512.png "$BG"   # maskable: inside the 80 % safe circle
logo 64 0.92 public/favicon.png "$BG"

for d in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  IFS=: read -r name px fg <<<"$d"
  logo "$px" 0.80 "$RES/mipmap-$name/ic_launcher.png" "$BG"
  round "$px" "$RES/mipmap-$name/ic_launcher_round.png"
  logo "$fg" 0.56 "$RES/mipmap-$name/ic_launcher_foreground.png"   # adaptive icon: 66/108 safe zone
done

for f in "$RES"/drawable*/splash.png; do
  read -r w h < <(identify -format '%w %h\n' "$f")
  s=$(( w < h ? w : h )); inner=$(( s * 34 / 100 ))
  convert "$TMP/master.png" -filter Lanczos -resize "${inner}x${inner}" -background "$BG" -gravity center -extent "${w}x${h}" -strip "$f"
done
echo "icons written"
