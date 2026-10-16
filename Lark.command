#!/bin/bash
# Lärk — duplo clique para iniciar no macOS.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
    [ -x "$dir/node" ] && export PATH="$dir:$PATH" && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  O Lärk precisa do Node.js 20 ou mais novo."
  echo "  Baixe e instale em https://nodejs.org e depois abra este atalho de novo."
  echo ""
  read -r -p "  Pressione Enter para fechar…"
  exit 1
fi
exec node scripts/lark.mjs "$@"
