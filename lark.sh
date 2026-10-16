#!/usr/bin/env bash
# Lärk — iniciar no Linux (duplo clique ou ./lark.sh).
cd "$(dirname "$(readlink -f "$0")")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for nvm_node in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$nvm_node/node" ] && export PATH="$nvm_node:$PATH"
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  O Lärk precisa do Node.js 20 ou mais novo."
  echo "  Instale pelo gerenciador de pacotes ou em https://nodejs.org e rode este script de novo."
  echo ""
  exit 1
fi
exec node scripts/lark.mjs "$@"
