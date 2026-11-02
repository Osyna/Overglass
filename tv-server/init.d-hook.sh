#!/bin/sh
# Overglass on-TV server boot hook (POSIX sh). Installed as /var/lib/webosbrew/init.d/webos-foundry-tv-server
# (mode 755); webosbrew runs every script in that directory as root at boot, and the installer runs it once by hand:
#   sh /var/lib/webosbrew/init.d/webos-foundry-tv-server [start|stop]
# start (default) is re-entrant: it stops the server it started before, then starts a fresh detached one.
# stop kills it and removes the pid file. Neither ever touches a process it did not start.
umask 077 # the log holds the first-boot token

DIR=${WOF_TV_DIR:-/var/lib/webosbrew/webos-foundry/tv-server}
PIDFILE=${WOF_TV_PIDFILE:-/tmp/webos-foundry-tv-server.pid}
LOG=${WOF_TV_LOG:-/tmp/webos-foundry-tv-server.log}
PATH=$PATH:/usr/bin:/usr/sbin:/bin:/sbin
export PATH

stop_server() {
  [ -f "$PIDFILE" ] || return 0
  pid=$(cat "$PIDFILE" 2>/dev/null)
  case $pid in '' | *[!0-9]*) rm -f "$PIDFILE"; return 0 ;; esac
  # A reused pid must not be killed: only a process whose command line is our server.js counts.
  case $(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) in
    *"$DIR/server.js"*)
      kill "$pid" 2>/dev/null
      n=0
      while [ "$n" -lt 25 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.2 2>/dev/null || sleep 1; n=$((n + 1)); done
      kill -9 "$pid" 2>/dev/null
      ;;
  esac
  rm -f "$PIDFILE"
}

start_server() {
  stop_server
  [ -f "$DIR/server.js" ] || { echo "Overglass TV server: $DIR/server.js is missing" >&2; exit 1; }
  cd "$DIR" || exit 1
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$DIR/server.js" >>"$LOG" 2>&1 </dev/null &
  else
    nohup node "$DIR/server.js" >>"$LOG" 2>&1 </dev/null &
  fi
  echo "$!" >"$PIDFILE"
  sleep 1
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "Overglass TV server: node exited at once; see $LOG" >&2; rm -f "$PIDFILE"; exit 1; }
}

case ${1-start} in
  start) start_server ;;
  stop) stop_server ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
