#!/bin/sh
# Cross-compile vtcap for the TV's 32-bit userland. The kernel is aarch64, so the
# cores implement armv7ve (hardware idiv) even though the userland is "armv7 softfp".
# install-vtcap registers the result under the dev-mode role/manifest id dev.webosfoundry.vtcap.
# Link inputs are the TV's own /lib/libc.so.6 and /lib/ld-linux.so.3, fetched into $LIBS
# (default /tmp/vt) with: ssh root@TV cat /lib/libc.so.6 > /tmp/vt/libc.so.6
# No ARM headers or sysroot are needed. Usage: build.sh [output]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
libs=${LIBS:-/tmp/vt}
for f in libc.so.6 ld-linux.so.3; do
    [ -f "$libs/$f" ] || { echo "missing $libs/$f: ssh root@TV cat /lib/$f > $libs/$f" >&2; exit 1; }
done
clang --target=armv7ve-linux-gnueabi -march=armv7ve -mfloat-abi=softfp -mfpu=neon -mthumb -O2 -Wall -Wextra \
    -ffreestanding -fno-stack-protector -nostdlib -fuse-ld=lld -Wl,--dynamic-linker=/lib/ld-linux.so.3 \
    -Wl,-z,noexecstack -Wl,--gc-sections -Wl,-s -o "${1:-$here/vtcap}" "$here/vtcap.c" "$libs/libc.so.6" "$libs/ld-linux.so.3"
