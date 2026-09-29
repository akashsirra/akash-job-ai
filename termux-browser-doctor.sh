#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "== Akash Job AI / Termux Browser Doctor =="

command -v tbp >/dev/null 2>&1 || {
  echo "FAIL: tbp is not installed."
  echo "Install:"
  echo "  pkg install -y tur-repo x11-repo"
  echo "  pkg install -y firefox xorg-server-xvfb xdotool xclip openbox python"
  echo "  git clone https://github.com/salviz/termux-browser-pilot ~/termux-browser-pilot"
  echo "  cd ~/termux-browser-pilot && bash setup.sh"
  exit 1
}

echo "PASS: tbp found: $(command -v tbp)"
tbp goto https://example.com
TITLE="$(tbp eval 'document.title' 2>/dev/null | tail -n 1 || true)"
TEXT="$(tbp text 2>/dev/null | head -n 20 || true)"

echo "Title: $TITLE"
echo "Page text:"
echo "$TEXT"

echo "$TEXT" | grep -qi "Example Domain" || {
  echo "FAIL: browser navigation did not reach example.com"
  exit 2
}

echo "PASS: navigation + page extraction work."
echo "Browser layer is ready for the job agent."
