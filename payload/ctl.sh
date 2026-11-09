#!/bin/sh
# 考试助手 启动/停止/状态。用 pid 文件保证只有一份在跑。
DIR=$(cd "$(dirname "$0")" && pwd)
# 和 watch.mjs 用同一个锁文件；放在部署目录外，升级改名也不会丢。
PIDFILE=${DSH_EXAM_LOCK:-$HOME/.dsh/exam-helper-watch.pid}
cd "$DIR" || exit 1

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "$1" in
  start)
    if alive; then echo "已经在跑：$(cat "$PIDFILE")"; exit 0; fi
    setsid nohup node watch.mjs >> watch.out 2>&1 < /dev/null &
    sleep 1
    echo "已启动：$(cat "$PIDFILE" 2>/dev/null)"
    ;;
  stop)
    if alive; then kill "$(cat "$PIDFILE")" 2>/dev/null; fi
    rm -f "$PIDFILE"
    echo "已停止"
    ;;
  status)
    if alive; then echo "运行中：$(cat "$PIDFILE")"; else echo "未运行"; fi
    ;;
  restart)
    "$DIR/ctl.sh" stop; sleep 1; "$DIR/ctl.sh" start
    ;;
  clean)
    "$DIR/ctl.sh" stop > /dev/null 2>&1
    rm -f watch.log watch.log.1 watch.out fail-*
    rm -rf corpus/auto
    echo "已清理日志、失败截图和自动保存的题目截图"
    ;;
  backup)
    BK=/sdcard/Download/DSH-Go
    mkdir -p "$BK" || { echo "无法创建 $BK"; exit 1; }
    NAME=exam-helper-$(date +%Y%m%d-%H%M).tar.gz
    tar czf "$BK/$NAME" -C "$DIR" . 2>/dev/null
    if [ -f "$BK/$NAME" ]; then
      echo "已备份：$BK/$NAME（$(du -h "$BK/$NAME" | cut -f1)）"
    else
      echo "备份失败"
    fi
    ;;
  *)
    echo "用法: $DIR/ctl.sh start|stop|restart|status|backup|clean"
    ;;
esac
