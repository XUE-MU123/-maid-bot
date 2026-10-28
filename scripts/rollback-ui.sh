#!/bin/bash
# 面板 UI 一键回退
# 用法：
#   ./scripts/rollback-ui.sh list          # 看有哪些备份
#   ./scripts/rollback-ui.sh <备份文件名>   # 回到那个备份
#   ./scripts/rollback-ui.sh last          # 回到上一个 git 提交

set -e
ROOT="/root/QQBOT/maid-bot"
BACKUP_DIR="/root/QQBOT/backups"

case "${1:-list}" in
  list)
    echo "=== 完整快照（tar 包）==="
    ls -lh "$BACKUP_DIR"/ui-*.tar.gz 2>/dev/null || echo "  （暂无）"
    echo
    echo "=== git 提交（每次改 UI 前自动记一笔）==="
    cd "$ROOT/web" && git log --oneline 2>/dev/null | head -20 || echo "  （还没有提交）"
    ;;
  last)
    cd "$ROOT/web"
    git checkout -- . 2>/dev/null || true
    git reset --hard HEAD~1
    echo "✅ 已回退到上一个提交："
    git log --oneline | head -1
    systemctl restart maid-bot
    echo "✅ 面板已重启"
    ;;
  *)
    FILE="$1"
    [ -f "$FILE" ] || FILE="$BACKUP_DIR/$1"
    if [ ! -f "$FILE" ]; then
      echo "❌ 找不到备份文件：$1"
      echo "先跑一次 ./scripts/rollback-ui.sh list 看看有哪些"
      exit 1
    fi
    cd "$ROOT"
    tar czf "/tmp/before-rollback-$(date +%s).tar.gz" web/
    tar xzf "$FILE" -C "$ROOT"
    echo "✅ 已从 $FILE 恢复 web/ 目录"
    systemctl restart maid-bot
    echo "✅ 面板已重启"
    ;;
esac
