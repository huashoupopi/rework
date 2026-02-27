#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
global_ignore="${HOME}/.config/git/ignore"

mkdir -p "${HOME}/.config/git"
touch "${global_ignore}"

append_if_missing() {
  local pattern="$1"
  if ! grep -Fxq "${pattern}" "${global_ignore}"; then
    echo "${pattern}" >> "${global_ignore}"
  fi
}

append_if_missing ".DS_Store"
append_if_missing "Thumbs.db"
append_if_missing "__pycache__/"
append_if_missing "*.pyc"
append_if_missing ".venv/"

git config --global core.excludesfile "${global_ignore}"
git -C "${repo_root}" config core.hooksPath .githooks
chmod +x "${repo_root}/.githooks/pre-commit"

echo "Git guard setup complete."
echo "Global ignore: ${global_ignore}"
echo "Repo hooksPath: .githooks"
