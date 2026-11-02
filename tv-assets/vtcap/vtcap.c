/*
 * vtcap: stream the TV's HDMI video plane as small RGB24 frames on stdout.
 *
 * Talks to the TV's own /usr/lib/libvtcapture.so.1 (dlopen; API as in
 * webosbrew/tv-native-apis libvtcapture/include/vtcapture/vtCaptureApi_c.h).
 * Declarations are written by hand: the workstation has no ARM libc headers.
 * Build with build.sh; the result runs on the TV as an ordinary executable.
 *
 * Stream: "C5F1", u16le width, u16le height, then frames of width*height*3
 * bytes (RGB24, row-major) with no per-frame header. Logs go to stderr.
 * Flags: -w W -h H (output size, default 160x90), -f FPS (30), -t SECONDS
 * (0 = run until SIGTERM/SIGINT/SIGHUP/closed pipe), -n FRAMES, -a CALLER,
 * -d DUMP (vtcapture dump location, default 2), -C WxH (capture size
 * request, default = output size), -u (swap U/V, NV12 instead of NV21), -v.
 * Exit: 0 clean, 2 usage, 3 capture setup failed, 4 capture stalled.
 */
#include <stddef.h>
#include <stdint.h>

extern long write(int, const void *, size_t);
extern int usleep(unsigned);
extern int clock_gettime(int, void *);
extern void *dlopen(const char *, int);
extern void *dlsym(void *, const char *);
extern void *signal(int, void (*)(int));
extern int snprintf(char *, size_t, const char *, ...);
extern int atoi(const char *);
extern int strcmp(const char *, const char *);
extern size_t strlen(const char *);
extern void *malloc(size_t);
extern int __libc_start_main(int (*)(int, char **), int, char **, void *, void *, void *, void *);

typedef struct { int32_t dump; int16_t x, y, w, h; int32_t buf_cnt, frm; } Props;
typedef struct { int32_t stride; int16_t pa, pb, pc, pd, aa, ab, ac, ad; } Plane;
typedef struct { uint8_t *a0, *a1; int32_t s0, s1; } Buf;

static void *(*vt_create)(void);
static int (*vt_init)(void *, const char *, char *);
static int (*vt_pre)(void *, char *, Props *);
static int (*vt_plane)(void *, char *, Plane *);
static int (*vt_process)(void *, char *);
static int (*vt_cur)(void *, Buf *);
static int (*vt_stop)(void *, char *);
static int (*vt_post)(void *, char *);
static int (*vt_fin)(void *, char *);
static int (*vt_release)(void *);

static volatile int quit;
static int verbose;
static void on_signal(int s) { (void)s; quit = 1; }

#define LOG(...) do { char m_[200]; int n_ = snprintf(m_, sizeof m_, __VA_ARGS__); write(2, m_, n_ > 0 ? (size_t)n_ : 0); } while (0)

static int64_t now_ms(int clock) {
    int32_t ts[2];
    clock_gettime(clock, ts);
    return (int64_t)ts[0] * 1000 + ts[1] / 1000000;
}

static int clamp(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/* Point-sample up to 4x4 per output pixel from NV12/NV21, convert BT.709 limited range. */
static void scale(const Buf *b, int stride, int sw, int sh, int swap, int ow, int oh, uint8_t *out) {
    for (int oy = 0; oy < oh; oy++) {
        int y0 = oy * sh / oh, ny = (oy + 1) * sh / oh - y0;
        ny = ny < 1 ? 1 : ny;
        int ky = ny > 4 ? 4 : ny;
        for (int ox = 0; ox < ow; ox++) {
            int x0 = ox * sw / ow, nx = (ox + 1) * sw / ow - x0;
            nx = nx < 1 ? 1 : nx;
            int kx = nx > 4 ? 4 : nx, ys = 0, us = 0, vs = 0;
            for (int j = 0; j < ky; j++) {
                int sy = y0 + (2 * j + 1) * ny / (2 * ky);
                const uint8_t *yr = b->a0 + sy * stride, *cr = b->a1 + (sy >> 1) * stride;
                for (int i = 0; i < kx; i++) {
                    int sx = x0 + (2 * i + 1) * nx / (2 * kx), c = sx & ~1;
                    ys += yr[sx];
                    us += cr[c + swap];
                    vs += cr[c + 1 - swap];
                }
            }
            int n = kx * ky, y = 298 * (ys / n - 16), u = us / n - 128, v = vs / n - 128;
            uint8_t *p = out + (oy * ow + ox) * 3;
            p[0] = clamp((y + 459 * v + 128) >> 8);
            p[1] = clamp((y - 55 * u - 136 * v + 128) >> 8);
            p[2] = clamp((y + 541 * u + 128) >> 8);
        }
    }
}

static int write_all(const uint8_t *p, size_t n) {
    while (n) {
        long r = write(1, p, n);
        if (r <= 0) return -1;
        p += r;
        n -= (size_t)r;
    }
    return 0;
}

static int run(int argc, char **argv) {
    int ow = 160, oh = 90, fps = 30, secs = 0, maxn = 0, dump = 2, cw = 0, ch = 0, swap = 0;
    const char *caller = "com.webos.tbtest.cap";
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : "";
        if (!strcmp(a, "-u")) swap = 1;
        else if (!strcmp(a, "-v")) verbose = 1;
        else if (!strcmp(a, "-w")) ow = atoi(argv[++i]);
        else if (!strcmp(a, "-h")) oh = atoi(argv[++i]);
        else if (!strcmp(a, "-f")) fps = atoi(argv[++i]);
        else if (!strcmp(a, "-t")) secs = atoi(argv[++i]);
        else if (!strcmp(a, "-n")) maxn = atoi(argv[++i]);
        else if (!strcmp(a, "-d")) dump = atoi(argv[++i]);
        else if (!strcmp(a, "-a")) caller = argv[++i];
        else if (!strcmp(a, "-C")) { cw = atoi(v); while (*v && *v != 'x') v++;
            ch = atoi(v + 1); i++; }
        else { LOG("usage: vtcap [-w W -h H -f FPS -t SEC -n N -d DUMP -C WxH -a CALLER -u -v]\n"); return 2; }
    }
    if (ow < 1 || oh < 1 || ow > 1920 || oh > 1080 || fps < 1 || fps > 120) { LOG("bad size/fps\n"); return 2; }
    if (!cw) { cw = ow; ch = oh; }

    void *lib = dlopen("libvtcapture.so.1", 2);
    if (!lib) { LOG("dlopen libvtcapture failed\n"); return 3; }
#define SYM(f, n) *(void **)&f = dlsym(lib, n); if (!f) { LOG("missing " n "\n"); return 3; }
    SYM(vt_create, "vtCapture_create") SYM(vt_init, "vtCapture_init") SYM(vt_pre, "vtCapture_preprocess")
    SYM(vt_plane, "vtCapture_planeInfo") SYM(vt_process, "vtCapture_process")
    SYM(vt_cur, "vtCapture_currentCaptureBuffInfo") SYM(vt_stop, "vtCapture_stop")
    SYM(vt_post, "vtCapture_postprocess") SYM(vt_fin, "vtCapture_finalize") SYM(vt_release, "vtCapture_release")

    signal(13, (void (*)(int))1); /* SIGPIPE ignored; write() failure ends the loop */
    signal(15, on_signal); signal(2, on_signal); signal(1, on_signal);

    char client[128] = "00";
    Props props = { dump, 0, 0, (int16_t)cw, (int16_t)ch, 3, fps };
    Plane pl = {0};
    Buf b;
    int rc = 3, stage = 0, r;
    void *drv = vt_create();
    if (!drv) { LOG("vtCapture_create failed\n"); return 3; }
    if ((r = vt_init(drv, caller, client))) { LOG("init failed %d\n", r); goto done; }
    stage = 1;
    if ((r = vt_pre(drv, client, &props))) { LOG("preprocess failed %d\n", r); goto done; }
    stage = 2;
    if ((r = vt_plane(drv, client, &pl))) { LOG("planeInfo failed %d\n", r); goto done; }
    LOG("plane stride %d region %d,%d %dx%d\n", pl.stride, pl.pa, pl.pb, pl.pc, pl.pd);
    if (pl.pc < 2 || pl.pd < 2 || pl.stride < pl.pc) { LOG("implausible plane\n"); goto done; }
    if ((r = vt_process(drv, client))) { LOG("process failed %d\n", r); goto done; }
    stage = 3;

    uint8_t *rgb = malloc((size_t)ow * oh * 3);
    uint8_t hdr[8] = { 'C', '5', 'F', '1', ow & 255, ow >> 8, oh & 255, oh >> 8 };
    if (write_all(hdr, 8)) goto done;
    rc = 0;
    int64_t t0 = now_ms(1), next = t0, changed = t0, first = 0, last_emit = 0, gap_max = 0;
    int frames = 0, errs = 0;
    uint8_t *last = 0;
    while (!quit && !(maxn && frames >= maxn) && !(secs && now_ms(1) - t0 >= secs * 1000)) {
        if ((r = vt_cur(drv, &b))) {
            if (verbose) LOG("currentCaptureBuffInfo %d\n", r);
            if (++errs > 300) { rc = 4; break; }
            usleep(20000);
            continue;
        }
        errs = 0;
        int64_t now = now_ms(1);
        int fresh = b.a0 != last || now - changed >= 1000;
        if (b.a0 != last) { last = b.a0; changed = now; } else if (fresh) changed = now;
        if (!fresh || now < next) { usleep(1000); continue; }
        next += 1000 / fps;
        if (next < now) next = now;
        scale(&b, pl.stride, pl.pc, pl.pd, swap, ow, oh, rgb);
        if (write_all(rgb, (size_t)ow * oh * 3)) break;
        if (!frames) first = now;
        else if (now - last_emit > gap_max) gap_max = now - last_emit;
        last_emit = now;
        frames++;
    }
    int64_t span = last_emit - first;
    LOG("frames %d span_ms %d gap_max_ms %d cpu_ms %d\n", frames, (int)span, (int)gap_max, (int)now_ms(2));
done:
    if (stage >= 3) vt_stop(drv, client);
    if (stage >= 2) vt_post(drv, client);
    if (stage >= 1) vt_fin(drv, client);
    vt_release(drv);
    return rc;
}

/* No crt1.o on the workstation. The ARM loader enters with r0 = rtld_fini and sp -> argc, argv. */
__attribute__((naked, noreturn)) void _start(void) {
    __asm__ volatile(
        "mov r1, sp\n"
        "mov r2, sp\n"
        "bic r2, r2, #7\n"
        "mov sp, r2\n"
        "bl vtcap_entry\n");
}

__attribute__((used, noreturn)) void vtcap_entry(void *rtld_fini, uintptr_t *sp) {
    __libc_start_main(run, (int)sp[0], (char **)(sp + 1), 0, 0, rtld_fini, sp);
    for (;;) usleep(1000000);
}
