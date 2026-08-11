#!/bin/bash
# 同步腳本：把這個資料夾的最新內容推到 GitHub meetmind- repo 的 search-frontend/ 子資料夾
#
# 使用時機：你（或 Claude Code）修改了 index.html / indextest.html / data.json 等檔案之後，
# 想把最新版本更新到 GitHub 上時執行。
#
# 用法：在這個資料夾（meeting-search）打開 Git Bash，執行：
#   bash sync-to-github.sh
#
# 這支腳本會：
#   1. 在系統暫存區複製一份 meetmind- repo（不影響你本機的檔案）
#   2. 把這個資料夾目前的內容（排除 backup/）覆蓋進 search-frontend/ 子資料夾
#   3. 提交並推送到 GitHub 的 main 分支
#
# 注意：這個腳本不會動到 meetmind- repo 根目錄的其他檔案
#      （那是另一個抽取工具的原始碼，index.html/package.json/src/ 等，安全不受影響）。

set -e  # 任何一步失敗就停止，不會半途推送壞掉的內容

REPO_URL="https://github.com/u92253024-source/meetmind-.git"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"

echo "== 1. 複製遠端 repo 到暫存區 =="
git clone "$REPO_URL" "$TMP_DIR/meetmind-"

echo "== 2. 更新 search-frontend/ 內容 =="
DEST="$TMP_DIR/meetmind-/search-frontend"
mkdir -p "$DEST"

# 先清空舊的 search-frontend 內容（保留 .git），再放入最新檔案，避免殘留已刪除的舊檔
find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

cp "$SRC_DIR/index.html" "$DEST/"
cp "$SRC_DIR/indextest.html" "$DEST/"
cp "$SRC_DIR/data.json" "$DEST/"
cp "$SRC_DIR/README.md" "$DEST/"
cp "$SRC_DIR/SPEC.md" "$DEST/"
cp "$SRC_DIR/REPORT.md" "$DEST/"
cp "$SRC_DIR/EXTRACTION.md" "$DEST/"
cp "$SRC_DIR/nccu_meeting_search_report_v1.html" "$DEST/"
cp -r "$SRC_DIR/pdf" "$DEST/"
echo "backup/
*.log
.DS_Store" > "$DEST/.gitignore"

echo "== 3. 檢查有沒有變更 =="
cd "$TMP_DIR/meetmind-"
if git diff --quiet && git diff --cached --quiet; then
  git add search-frontend/
fi
git add search-frontend/

if git diff --cached --quiet; then
  echo "沒有偵測到任何變更，不需要推送。"
  rm -rf "$TMP_DIR"
  exit 0
fi

echo "== 4. 建立 commit =="
read -p "請輸入這次更新的簡短說明（例如：修正搜尋排序 bug）： " MSG
MSG=${MSG:-"更新 search-frontend"}
git config user.email "u92253024@gmail.com"
git config user.name "Ken Liu"
git commit -m "更新 search-frontend：$MSG"

echo "== 5. 推送到 GitHub main 分支 =="
git push origin main

echo ""
echo "完成！已更新：https://github.com/u92253024-source/meetmind-/tree/main/search-frontend"
rm -rf "$TMP_DIR"
