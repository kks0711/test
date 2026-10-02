#!/bin/bash
# usage: render.sh <deck.pptx> <outprefix> [dpi]
cp "$1" /tmp/claude-0/r.pptx; cd /tmp/claude-0
export HOME=/tmp/claude-0/home
timeout 300 soffice -env:UserInstallation=file:///tmp/claude-0/lo --headless --convert-to pdf --outdir /tmp/claude-0 r.pptx >/dev/null 2>&1
rm -f /tmp/claude-0/prev/$2-*; pdftoppm -r ${3:-45} -png r.pdf /tmp/claude-0/prev/$2; ls /tmp/claude-0/prev | grep -c "^$2"
