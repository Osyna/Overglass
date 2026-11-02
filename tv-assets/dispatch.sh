#!/bin/sh
# webOS Foundry forced-command dispatcher (POSIX sh, never eval). sshd runs it for the dedicated key:
#   command="sh /var/lib/webosbrew/webos-foundry/dispatch.sh",restrict ssh-ed25519 ...
# The client's request arrives in $SSH_ORIGINAL_COMMAND; it is matched verb by verb against the grammar in
# ARCHITECTURE.md section 3 and every argument is validated again here. Anything else exits 64.
LC_ALL=C
export LC_ALL
umask 022
set -f

D=/var/lib/webosbrew/webos-foundry
LOCK=/tmp/webos-foundry.lock
TMP=/tmp
# vtcap lives on the dev-mode storage the original capture client was proven to execute from.
VTDIR=/media/developer/webos-foundry-vtcap
LS2=/var/luna-service2-dev
LSCTL=/usr/sbin/ls-control
# Root-context boot hooks (the webosbrew init.d mechanism); only webos-foundry-* names are ever written or run.
HOOKDIR=/var/lib/webosbrew/init.d
OVERLAY_ID=dev.webosfoundry.overlay
VT_ID=dev.webosfoundry.vtcap
INSTALLER=luna://com.webos.appInstallService/dev/
BUSY="TV is busy with AI processing or another change; try again shortly."
FILE_MAX=2097152  # raw bytes, one whole-file install/overlay/vtcap/hook upload (no base64 tax now: stdin, not argv)
TREE_CHUNK_MAX=4194304  # raw bytes, one install-tree chunk
CARD_MAX=65536  # raw bytes, one notify-overlay widget-tree JSON upload

deny() {
  echo "webos-foundry: $1" >&2
  exit 64
}

# --- argument validators (each mirrors one token of the section 3 grammar) -----------------------------

is_b64() { # value maxlen  ==  [A-Za-z0-9+/]{1,maxlen}={0,2}   (no ${v#"$b"}: quadratic on a 120 KB value in some shells)
  b=${1%%=*}
  case $b in '' | *[!A-Za-z0-9+/]*) return 1 ;; esac
  case $1 in *=*[!=]*) return 1 ;; esac
  [ $((${#1} - ${#b})) -le 2 ] && [ "${#b}" -le "$2" ]
}

is_int() { # value mindigits maxdigits  ==  [0-9]{min,max}
  case $1 in '' | *[!0-9]*) return 1 ;; esac
  [ "${#1}" -ge "$2" ] && [ "${#1}" -le "$3" ]
}

is_ident() { # [A-Za-z][A-Za-z0-9_]*
  case $1 in [A-Za-z]*) ;; *) return 1 ;; esac
  case $1 in *[!A-Za-z0-9_]*) return 1 ;; esac
}

is_tree_path() { # 2-8 components of [A-Za-z0-9_-][A-Za-z0-9._-]{0,63}, whole path <= 200: never "..", dotfiles, "/x" or "a//b"
  [ "${#1}" -le 200 ] || return 1
  rest=$1
  n=0
  while :; do
    part=${rest%%/*}
    case $part in '' | [!A-Za-z0-9_-]* | *[!A-Za-z0-9._-]*) return 1 ;; esac
    [ "${#part}" -le 64 ] || return 1
    n=$((n + 1))
    case $rest in */*) rest=${rest#*/} ;; *) break ;; esac
  done
  [ "$n" -ge 2 ] && [ "$n" -le 8 ]
}

is_hook() { # webos-foundry-[a-z0-9-]{1,48}
  case $1 in webos-foundry-*) ;; *) return 1 ;; esac
  rest=${1#webos-foundry-}
  case $rest in '' | *[!a-z0-9-]*) return 1 ;; esac
  [ "${#rest}" -le 48 ]
}

is_profile() { # [A-Za-z][A-Za-z0-9_-]*
  case $1 in [A-Za-z]*) ;; *) return 1 ;; esac
  case $1 in *[!A-Za-z0-9_-]*) return 1 ;; esac
}

dec() { # strip leading zeros so $(( )) never reads octal
  n=$1
  while :; do
    case $n in 0?*) n=${n#0} ;; *) break ;; esac
  done
  echo "$n"
}

# Reads at most $1 bytes of this request's stdin into new file $2 (truncating); rejects (removes $2, denies)
# an empty or oversized upload. Same bounded-read shape as do_process's media upload, reused here so every
# file-push verb sends its payload as stdin, not as a command argument (dropbear chokes well under 1 KiB of
# base64 margin once the whole SSH command crosses a few KiB; ARCHITECTURE.md records the measured cliff).
read_upload() { # maxbytes dest
  head -c $(($1 + 1)) >"$2"
  n=$(wc -c <"$2")
  if [ "$n" -gt "$1" ] || [ "$n" -eq 0 ]; then
    rm -f "$2"
    echo "Upload must be 1-$1 bytes" >&2
    exit 1
  fi
}

# Runs a command under the TV lock; lock timeout (rc 75) is reported as the shared "busy" message.
locked() { # waitseconds command...
  w=$1
  shift
  flock -w "$w" -E 75 "$LOCK" "$@" </dev/null
  rc=$?
  [ "$rc" -eq 75 ] && echo "$BUSY" >&2
  return "$rc"
}

# --- verbs ---------------------------------------------------------------------------------------------

do_status() {
  sh "$D/status.sh"
  echo
  echo @@@
  luna-send -n 1 -w 1500 luna://com.webos.service.audio/master/getVolume '{}' </dev/null || true
}

do_screenshot() { # width height jpg|png
  w=$(dec "$1")
  h=$(dec "$2")
  [ $((w % 2)) -eq 0 ] && [ $((h % 2)) -eq 0 ] || deny "width and height must be even"
  [ "$w" -ge 64 ] && [ "$w" -le 3840 ] && [ "$h" -ge 36 ] && [ "$h" -le 2160 ] || deny "size out of range"
  d=$((w * 9 - h * 16))
  [ "$d" -le 16 ] && [ "$d" -ge -16 ] || deny "height must keep the 16:9 picture shape"
  case $3 in jpg) fmt=JPG ;; png) fmt=PNG ;; esac
  p=$TMP/webos-foundry-shot-$$.$3
  trap 'rm -f "$p"' EXIT
  req=$(printf '{"path":"%s","method":"VIDEO","format":"%s","width":%s,"height":%s}' "$p" "$fmt" "$w" "$h")
  r=$(luna-send -n 1 -w 8000 luna://com.webos.service.capture/executeOneShot "$req" </dev/null)
  case $r in
    *'"returnValue":true'*) [ -s "$p" ] && cat "$p" && exit 0 ;;
  esac
  echo "Capture failed: $r" >&2
  exit 3
}

do_notify_overlay() { # payload is this request's stdin
  p=$TMP/webos-foundry-card-$$.json
  trap 'rm -f "$p"' EXIT
  read_upload "$CARD_MAX" "$p"
  node "$D/notify.js" overlay "$p" </dev/null
}

do_process() { # image|audio profile arg...   (the media upload is this session's stdin)
  kind=$1
  profile=$2
  shift 2
  if [ "$kind" = image ]; then
    input=input.mp4 cap=16777216 result=captured.png script=process-image.js
  else
    input=input.wav cap=8388608 result=captured.wav script=process-audio.js
  fi
  trap '' HUP # a dropped client must not stop a job that has to restore the TV
  umask 077
  ws=$(mktemp -d "$TMP/webos-foundry-ai.XXXXXXXX") || { echo "Cannot create a TV workspace" >&2; exit 1; }
  head -c $((cap + 1)) >"$ws/$input"
  if [ "$(wc -c <"$ws/$input")" -gt "$cap" ]; then
    rm -rf "$ws"
    echo "Upload is larger than $cap bytes" >&2
    exit 1
  fi
  flock -n -E 75 "$LOCK" node "$D/$script" "$ws" "$profile" "$@" >"$ws/result.json" 2>"$ws/error.txt" </dev/null
  rc=$?
  if [ "$rc" -eq 75 ]; then
    rm -rf "$ws"
    echo "$BUSY" >&2
    exit 75
  fi
  if [ "$rc" -ne 0 ]; then
    cat "$ws/error.txt" >&2
    # Only a failed restoration needs restore.json/the media again; everything else is already clean.
    case $(cat "$ws/error.txt") in
      *'Restoration failed'*) echo "Private TV workspace kept for recovery: $ws" >&2 ;;
      *) rm -rf "$ws" ;;
    esac
    exit "$rc"
  fi
  [ -s "$ws/$result" ] || { cat "$ws/error.txt" >&2; echo "TV produced no $result; workspace kept: $ws" >&2; exit 1; }
  cat "$ws/result.json" "$ws/$result"
  rc=$?
  rm -rf "$ws"
  exit "$rc"
}

do_install_status() {
  out='{"files":{'
  for f in status.sh details.js notify.js settings.js remote.js process-image.js process-audio.js apps.js dispatch.sh; do
    [ -f "$D/$f" ] && v=true || v=false
    out=$out'"'$f'":'$v,
  done
  out=${out%,}'},"overlay":'
  if [ -d "/media/developer/apps/usr/palm/applications/$OVERLAY_ID" ] || [ -d "/usr/palm/applications/$OVERLAY_ID" ]; then out=${out}true; else out=${out}false; fi
  if [ -x "$VTDIR/vtcap" ] && [ -f "$LS2/roles.d/$VT_ID.json" ]; then out=${out}',"vtcap":true}'; else out=${out}',"vtcap":false}'; fi
  echo "$out"
}

do_install() { # name  (payload is this request's stdin)
  case $1 in
    dispatch.sh | status.sh) mode=755 ;;
    details.js | notify.js | settings.js | remote.js | process-image.js | process-audio.js | apps.js) mode=644 ;;
    *) deny "unknown file" ;;
  esac
  mkdir -p "$D" || exit 1
  read_upload "$FILE_MAX" "$D/$1.new"
  chmod "$mode" "$D/$1.new" && mv "$D/$1.new" "$D/$1"
}

do_install_tree() { # path put|begin|more|end  (chunk payload is this request's stdin): one file (or one chunk
                     # of it) under $D, atomically renamed on put/end
  f=$D/$1
  [ ! -d "$f" ] && mkdir -p "${f%/*}" || { echo "Cannot write $1" >&2; exit 1; }
  case $2 in
    put | begin) : >"$f.part" || exit 1 ;;
    *) [ -f "$f.part" ] || { echo "No upload in progress for $1" >&2; exit 1; } ;;
  esac
  before=$(wc -c <"$f.part")
  head -c $((TREE_CHUNK_MAX + 1)) >>"$f.part"
  added=$(($(wc -c <"$f.part") - before))
  if [ "$added" -gt "$TREE_CHUNK_MAX" ] || [ "$added" -eq 0 ]; then
    rm -f "$f.part"
    echo "Upload chunk must be 1-$TREE_CHUNK_MAX bytes" >&2
    exit 1
  fi
  case $2 in put | end) mv "$f.part" "$f" || exit 1 ;; esac
}

do_install_hook() { # name  (payload is this request's stdin)
  mkdir -p "$HOOKDIR" || exit 1
  read_upload "$FILE_MAX" "$HOOKDIR/.$1.new"
  chmod 755 "$HOOKDIR/.$1.new" && mv "$HOOKDIR/.$1.new" "$HOOKDIR/$1"
}

do_run_hook() { # name start|stop; output is captured so a daemon the hook starts cannot hold this SSH session open
  [ -x "$HOOKDIR/$1" ] || { echo "No such hook: $1" >&2; exit 1; }
  out=$(umask 077 && mktemp "$TMP/webos-foundry-hook.XXXXXXXX") || exit 1
  sh "$HOOKDIR/$1" "$2" </dev/null >"$out" 2>&1
  rc=$?
  cat "$out"
  rm -f "$out"
  return "$rc"
}

installer() { # install|remove json
  timeout 85 luna-send -w 84000 -i "$INSTALLER$1" "$2" </dev/null || true
}

do_install_overlay() { # payload is this request's stdin
  ipk=$TMP/$OVERLAY_ID.ipk
  trap 'rm -f "$ipk"' EXIT
  (umask 077 && head -c $((FILE_MAX + 1)) >"$ipk")
  n=$(wc -c <"$ipk")
  [ "$n" -gt 0 ] && [ "$n" -le "$FILE_MAX" ] || { echo "Empty or oversized IPK" >&2; exit 1; }
  out=$(installer install '{"id":"com.ares.defaultName","ipkUrl":"'"$ipk"'","subscribe":true}')
  if printf '%s\n' "$out" | grep -Eq '"state"[[:space:]]*:[[:space:]]*"installed"'; then
    echo "Overlay installed"
  else
    echo "Overlay install did not complete: $out" >&2
    exit 1
  fi
}

remove_overlay() {
  out=$(installer remove '{"id":"'"$OVERLAY_ID"'","subscribe":true}')
  printf '%s\n' "$out" | grep -Eq '"state"[[:space:]]*:[[:space:]]*"removed"'
}

do_uninstall_overlay() {
  remove_overlay && echo "Overlay removed" || { echo "Overlay removal did not complete" >&2; exit 1; }
}

do_install_vtcap() { # payload is this request's stdin
  mkdir -p "$VTDIR" "$LS2/roles.d" "$LS2/manifests.d" || exit 1
  read_upload "$FILE_MAX" "$VTDIR/vtcap.new"
  chmod 755 "$VTDIR/vtcap.new" && mv "$VTDIR/vtcap.new" "$VTDIR/vtcap" || exit 1
  # Names and rights: only what vtCapture_create needs (captureservice's own role minus its server names).
  printf '%s' '{"exeName":"'"$VTDIR"'/vtcap","type":"regular","allowedNames":["com.webos.service.capture.client*","com.webos.rm.client.*"],"permissions":[{"service":"com.webos.service.capture.client*","outbound":["*"]},{"service":"com.webos.rm.client.*","outbound":["com.webos.media"]}]}' >"$LS2/roles.d/$VT_ID.json" || exit 1
  printf '%s' '{"id":"'"$VT_ID"'","version":"1.0.0","roleFiles":["'"$LS2/roles.d/$VT_ID.json"'"]}' >"$LS2/manifests.d/$VT_ID.json" || exit 1
  "$LSCTL" scan-volatile-dirs </dev/null
  echo "vtcap installed"
}

remove_vtcap() {
  rm -f "$LS2/roles.d/$VT_ID.json" "$LS2/manifests.d/$VT_ID.json" "$VTDIR/vtcap" "$VTDIR/vtcap.new"
  rmdir "$VTDIR" 2>/dev/null
  "$LSCTL" scan-volatile-dirs </dev/null
}

do_uninstall_all() {
  remove_overlay
  remove_vtcap
  set +f
  for h in "$HOOKDIR"/webos-foundry-*; do
    [ -f "$h" ] || continue
    sh "$h" stop </dev/null >/dev/null 2>&1
    rm -f "$h"
  done
  set -f
  rm -rf "$D"
  echo "webOS Foundry removed from the TV (scripts, overlay app, vtcap role, boot hooks)."
  echo "Delete the line containing webos-foundry/dispatch.sh from /home/root/.ssh/authorized_keys by hand."
  exit 0
}

# --- request parsing -----------------------------------------------------------------------------------

cmd=${SSH_ORIGINAL_COMMAND-}
case $cmd in
  '') deny "no command" ;;
  # Whole-request allowlist: also rejects newlines, $, `, ;, &, |, quotes, backslashes and globs.
  *[!A-Za-z0-9+/=._' '-]*) deny "unexpected character in command" ;;
  ' '* | *' ' | *'  '*) deny "malformed spacing" ;;
esac
IFS=' '
set -- $cmd
verb=$1
argc=$#

case $verb in
  status)
    [ "$argc" -eq 1 ] || deny "usage: status"
    do_status
    ;;
  details)
    [ "$argc" -eq 1 ] || deny "usage: details"
    exec node "$D/details.js" </dev/null
    ;;
  remote)
    case "$argc ${2-}" in
      '2 wake' | '2 power_off' | '2 home' | '2 back' | '2 up' | '2 down' | '2 left' | '2 right' | '2 ok' | \
        '2 mute' | '2 unmute' | '2 volume_up' | '2 volume_down')
        locked 5 node "$D/remote.js" "$2"
        ;;
      '3 hdmi')
        case $3 in [1-4]) ;; *) deny "HDMI input must be 1-4" ;; esac
        locked 5 node "$D/remote.js" hdmi "$3"
        ;;
      *) deny "usage: remote <action> | remote hdmi <1-4>" ;;
    esac
    ;;
  settings-list)
    [ "$argc" -eq 1 ] || deny "usage: settings-list"
    locked 5 node "$D/settings.js" list
    ;;
  settings-set)
    [ "$argc" -eq 4 ] && is_ident "$2" && is_ident "$3" && is_b64 "$4" 4000 || deny "usage: settings-set <category> <key> <base64>"
    locked 5 node "$D/settings.js" set "$2" "$3" "$4"
    ;;
  notify-toast)
    [ "$argc" -eq 2 ] && is_b64 "$2" 400 || deny "usage: notify-toast <base64>"
    exec node "$D/notify.js" toast "$2" </dev/null
    ;;
  notify-say)
    [ "$argc" -eq 2 ] || { [ "$argc" -eq 3 ] && is_int "$3" 1 2; } || deny "usage: notify-say <base64> [volume]"
    is_b64 "$2" 400 || deny "usage: notify-say <base64> [volume]"
    locked 10 node "$D/notify.js" say "$2" ${3+"$3"}
    ;;
  notify-overlay)
    [ "$argc" -eq 1 ] || deny "usage: notify-overlay"
    do_notify_overlay
    ;;
  screenshot)
    [ "$argc" -eq 4 ] && is_int "$2" 2 4 && is_int "$3" 2 4 || deny "usage: screenshot <width> <height> jpg|png"
    case $4 in jpg | png) ;; *) deny "format must be jpg or png" ;; esac
    do_screenshot "$2" "$3" "$4"
    ;;
  stream-start)
    [ "$argc" -eq 6 ] && is_int "$2" 2 4 && is_int "$3" 2 4 && is_int "$4" 1 3 && is_int "$5" 1 4 || deny "usage: stream-start <w> <h> <fps> <seconds> <dump>"
    case $6 in [0-5]) ;; *) deny "dump must be 0-5" ;; esac
    # The process becomes the SSH session: SIGTERM/closed pipe from the client is the only way to stop it.
    exec "$VTDIR/vtcap" -w "$(dec "$2")" -h "$(dec "$3")" -f "$(dec "$4")" -t "$(dec "$5")" -d "$6"
    ;;
  process-image)
    [ "$argc" -eq 4 ] && is_profile "$2" && is_int "$3" 2 4 && is_int "$4" 2 4 || deny "usage: process-image <profile> <width> <height>"
    do_process image "$2" "$3" "$4"
    ;;
  process-audio)
    [ "$argc" -eq 3 ] && is_profile "$2" && is_int "$3" 1 2 || deny "usage: process-audio <profile> <seconds>"
    do_process audio "$2" "$3"
    ;;
  idle-wait)
    [ "$argc" -eq 1 ] || deny "usage: idle-wait"
    locked 25 true
    ;;
  install-status)
    [ "$argc" -eq 1 ] || deny "usage: install-status"
    do_install_status
    ;;
  install)
    [ "$argc" -eq 2 ] || deny "usage: install <file>"
    do_install "$2"
    ;;
  install-overlay)
    [ "$argc" -eq 1 ] || deny "usage: install-overlay"
    do_install_overlay
    ;;
  uninstall-overlay)
    [ "$argc" -eq 1 ] || deny "usage: uninstall-overlay"
    do_uninstall_overlay
    ;;
  install-vtcap)
    [ "$argc" -eq 1 ] || deny "usage: install-vtcap"
    do_install_vtcap
    ;;
  uninstall-vtcap)
    [ "$argc" -eq 1 ] || deny "usage: uninstall-vtcap"
    remove_vtcap
    ;;
  uninstall-all)
    [ "$argc" -eq 1 ] || deny "usage: uninstall-all"
    do_uninstall_all
    ;;
  app-list)
    [ "$argc" -eq 1 ] || deny "usage: app-list"
    exec node "$D/apps.js" list </dev/null
    ;;
  app-install)
    [ "$argc" -eq 2 ] && is_b64 "$2" 1000 || deny "usage: app-install <base64>"
    exec node "$D/apps.js" install "$2" </dev/null
    ;;
  app-uninstall)
    [ "$argc" -eq 2 ] && is_b64 "$2" 200 || deny "usage: app-uninstall <base64>"
    exec node "$D/apps.js" uninstall "$2" </dev/null
    ;;
  install-tree)
    [ "$argc" -eq 3 ] && is_tree_path "$2" || deny "usage: install-tree <dir/file> put|begin|more|end"
    case $3 in put | begin | more | end) ;; *) deny "mode must be put, begin, more or end" ;; esac
    do_install_tree "$2" "$3"
    ;;
  install-hook)
    [ "$argc" -eq 2 ] && is_hook "$2" || deny "usage: install-hook <webos-foundry-name>"
    do_install_hook "$2"
    ;;
  run-hook)
    [ "$argc" -eq 3 ] && is_hook "$2" || deny "usage: run-hook <webos-foundry-name> start|stop"
    case $3 in start | stop) ;; *) deny "action must be start or stop" ;; esac
    do_run_hook "$2" "$3"
    ;;
  *) deny "unknown request" ;;
esac
exit $?
