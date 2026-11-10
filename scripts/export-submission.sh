#!/usr/bin/env bash
# 提出用リポジトリ（Devfest-Hackathon-2026/df-2026-t001）に置く内容を、この開発リポジトリの「追跡されているファイル」から作る。
#   scripts/export-submission.sh /path/to/df-2026-t001
# 除くもの: ピッチ用メディア(LFS・1.8GB)、内部メモ・台帳・テスト結果の記録、旧モック(legacy)、スクリーンショット用スクリプト。
# 提出用リポジトリの README.md と LICENSE は上書きしない（README は別に書く）。履歴は持ち込まない（新しいコミットだけ）。
set -euo pipefail
SRC="$(git rev-parse --show-toplevel)"
DST="${1:?提出用リポジトリのパスを指定してください}"
[ -d "$DST/.git" ] || { echo "$DST は git リポジトリではありません"; exit 1; }

EXCLUDE='^(media/|legacy/|artifacts/|docs/project/|CURSOR_PROMPT\.md$|BACKLOG\.md$|COMPLETE_TEST_RESULTS\.md$|FINAL_[A-Z_]*\.md$|RV31_COMPLETION\.md$|TEST_RESULTS\.md$|screenshot-[a-z0-9-]*\.mjs$|\.assetsignore$|\.gitattributes$|README\.md$|LICENSE$)'

cd "$DST"
git rm -r -q --cached . 2>/dev/null || true
find . -mindepth 1 -maxdepth 1 ! -name .git ! -name LICENSE ! -name README.md -exec rm -rf {} +
cd "$SRC"
git ls-files -z | while IFS= read -r -d '' f; do
  if ! printf '%s' "$f" | grep -Eq "$EXCLUDE"; then
    mkdir -p "$DST/$(dirname "$f")"; cp -p "$f" "$DST/$f"
  fi
done
cd "$DST" && git add -A
echo "files: $(git ls-files | wc -l)  size: $(du -sh --exclude=.git . 2>/dev/null | cut -f1 || du -sh . | cut -f1)"
