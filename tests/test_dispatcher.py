import pytest

from webos_foundry import dispatcher as d
from webos_foundry.errors import ValidationError

B64 = "QUJD"

# verb -> (strings the TV-side grammar must accept, strings it must reject)
CASES = {
    "status": (["status"], ["status ", "status x", "Status", ""]),
    "details": (["details"], ["details 1", "detail"]),
    "remote": (["remote home", "remote wake", "remote volume_down", "remote hdmi 1", "remote hdmi 4",
                "remote volume 0", "remote volume 9", "remote volume 40", "remote volume 99", "remote volume 100"],
               ["remote hdmi", "remote hdmi 0", "remote hdmi 5", "remote hdmi 12", "remote nope", "remote home 1",
                "remote volume", "remote volume true", "remote volume 1.5", "remote volume -1", "remote volume 101",
                "remote volume 00", "remote volume 01", "remote volume 040", "remote volume +1",
                "remote volume 1e1", "remote volume 1 2", "remote volume 40; id", "remote volume 40\n",
                "remote  home", "remote home; id", "remote home\n"]),
    "settings-list": (["settings-list"], ["settings-list x"]),
    "settings-set": (["settings-set aiPicture ai_Picture " + B64, "settings-set a b QQ==", "settings-set a b " + "A" * 4000],
                     ["settings-set 1a b QQ==", "settings-set a b-c QQ==", "settings-set a b", "settings-set a b ===",
                      "settings-set a b " + "A" * 4001, "settings-set a b QQ===", "settings-set a b Q Q",
                      "settings-set a b QQ==; id"]),
    "notify-toast": (["notify-toast " + B64, "notify-toast " + "A" * 400],
                     ["notify-toast", "notify-toast " + "A" * 401, "notify-toast Q!Q=", "notify-toast QQ==="]),
    "notify-say": (["notify-say " + B64, "notify-say " + B64 + " 15", "notify-say " + B64 + " 5"],
                   ["notify-say " + B64 + " 150", "notify-say " + B64 + " x", "notify-say " + B64 + " -1",
                    "notify-say", "notify-say " + "A" * 401]),
    "notify-overlay": (["notify-overlay"], ["notify-overlay ", "notify-overlay x", "notify-overlay " + B64]),
    "screenshot": (["screenshot 1920 1080 jpg", "screenshot 64 36 png"],
                   ["screenshot 1920 1080 gif", "screenshot 1 1080 jpg", "screenshot 19200 1080 jpg",
                    "screenshot 1920 1080", "screenshot a b jpg"]),
    "stream-start": (["stream-start 160 90 30 0 2", "stream-start 1920 1080 999 9999 5"],
                     ["stream-start 160 90 30 0 6", "stream-start 160 90 30 0", "stream-start 160 90 1000 0 2",
                      "stream-start 160 90 30 10000 2", "stream-start 16 9 -1 0 2"]),
    "process-image": (["process-image ai-picture-sr 960 540", "process-image standard 1920 1080"],
                      ["process-image 1bad 960 540", "process-image -x 960 540", "process-image ai-picture-sr 960",
                       "process-image ai-picture-sr 96000 540", "process-image a;b 960 540"]),
    "process-audio": (["process-audio ai-sound 5", "process-audio clear-voice 30"],
                      ["process-audio ai-sound", "process-audio ai-sound 100", "process-audio 9x 5",
                       "process-audio ai-sound x"]),
    "idle-wait": (["idle-wait"], ["idle-wait 1"]),
    "install-status": (["install-status"], ["install-status x"]),
    "install": (["install dispatch.sh", "install status.sh", "install process-audio.js"],
                ["install evil.sh", "install ../dispatch.sh", "install", "install dispatch.sh ",
                 "install dispatch.sh extra", "install dispatch.sh\n", "install statusXsh"]),
    "install-overlay": (["install-overlay"], ["install-overlay ", "install-overlay x"]),
    "uninstall-overlay": (["uninstall-overlay"], ["uninstall-overlay now"]),
    "install-vtcap": (["install-vtcap"], ["install-vtcap ", "install-vtcap a b"]),
    "uninstall-vtcap": (["uninstall-vtcap"], ["uninstall-vtcap x"]),
    "uninstall-all": (["uninstall-all"], ["uninstall-all x"]),
    "app-list": (["app-list"], ["app-list x", "app-list "]),
    "app-install": (["app-install " + B64, "app-install " + "A" * 1000, "app-install QQ=="],
                    ["app-install", "app-install " + "A" * 1001, "app-install QQ===", "app-install QQ==; id",
                     "app-install $(id)", "app-install a-b", "app-install " + B64 + "\n", "app-install a b"]),
    "app-uninstall": (["app-uninstall " + B64, "app-uninstall " + "A" * 200],
                      ["app-uninstall", "app-uninstall " + "A" * 201, "app-uninstall `id`", "app-uninstall QQ=== "]),
    "install-tree": (["install-tree tv-server/server.js put", "install-tree tv-server/web/a-b_c.1/app.js begin",
                      "install-tree a/b more", "install-tree a/b end",
                      "install-tree " + "/".join(["d"] * 8) + " put"],
                     ["install-tree server.js put",  # top-level files (dispatch.sh, the scripts) are never writable
                      "install-tree ../x/y put", "install-tree a/../b put", "install-tree a/.. put",
                      "install-tree a/./b put", "install-tree /etc/passwd put",
                      "install-tree /a/b put", "install-tree a/b/ put", "install-tree a//b put",
                      "install-tree a/.hidden put", "install-tree .a/b put",
                      "install-tree a/b;id put", "install-tree a/$(id) put",
                      "install-tree " + "/".join(["d"] * 9) + " put",  # too deep
                      "install-tree a/" + "b" * 65 + " put", "install-tree " + "/".join(["d" * 40] * 6) + " put",
                      "install-tree a/b exec", "install-tree a/b", "install-tree a/b put extra",
                      "install-tree a/b put\n"]),
    "install-hook": (["install-hook webos-foundry-tv-server", "install-hook webos-foundry-x"],
                     ["install-hook tv-server", "install-hook webos-foundry-",
                      "install-hook webos-foundry-../x", "install-hook webos-foundry-Up",
                      "install-hook webos-foundry-a.sh", "install-hook ../init.d/x",
                      "install-hook webos-foundry-" + "a" * 49, "install-hook"]),
    "run-hook": (["run-hook webos-foundry-tv-server start", "run-hook webos-foundry-tv-server stop"],
                 ["run-hook webos-foundry-tv-server", "run-hook webos-foundry-tv-server restart", "run-hook sh start",
                  "run-hook webos-foundry-x;id start", "run-hook ../../bin/sh start", "run-hook webos-foundry-x start x"]),
}


def test_every_grammar_verb_has_cases():
    assert set(CASES) == set(d.GRAMMAR)


@pytest.mark.parametrize("verb", sorted(CASES))
def test_grammar_accepts_and_rejects(verb):
    accept, reject = CASES[verb]
    assert accept and reject
    for command in accept:
        assert d.GRAMMAR[verb].fullmatch(command), command
        assert d.verb_of(command) == verb
    for command in reject:
        assert not d.GRAMMAR[verb].fullmatch(command), command


def test_verb_of_rejects_non_strings_and_unknown():
    assert d.verb_of("rm -rf /") is None and d.verb_of(None) is None and d.verb_of(b"status") is None


def test_builders_produce_accepted_commands():
    built = [
        d.build_status(), d.build_details(), d.build_remote("volume_up"), d.build_remote("hdmi", 3),
        d.build_settings_list(), d.build_settings_set("sound", "soundMode", B64), d.build_notify_toast(B64),
        d.build_notify_say(B64), d.build_notify_say(B64, 20), d.build_notify_overlay(),
        d.build_screenshot(1920, 1080, "png"), d.build_stream_start(160, 90, 30, 0, 2),
        d.build_process_image("standard", 960, 540), d.build_process_audio("ai-sound", 3), d.build_idle_wait(),
        d.build_install_status(), d.build_install("notify.js"), d.build_install_overlay(),
        d.build_uninstall_overlay(), d.build_install_vtcap(), d.build_uninstall_vtcap(), d.build_uninstall_all(),
        d.build_app_list(), d.build_app_install(B64), d.build_app_uninstall(B64),
        d.build_install_tree("tv-server/server.js", "put"), d.build_install_hook("webos-foundry-tv-server"),
        d.build_run_hook("webos-foundry-tv-server"), d.build_run_hook("webos-foundry-tv-server", "stop"),
    ]
    assert all(d.verb_of(command) for command in built)
    assert d.build_remote("hdmi", 3) == "remote hdmi 3"
    assert d.build_notify_say(B64, 20) == "notify-say QUJD 20"
    assert d.build_stream_start(160, 90, 30, 0, 2) == "stream-start 160 90 30 0 2"
    assert d.build_screenshot(1920, 1080, "png") == "screenshot 1920 1080 png"


@pytest.mark.parametrize("call", [
    lambda: d.build_remote("nope"), lambda: d.build_remote("hdmi"), lambda: d.build_remote("hdmi", 5),
    lambda: d.build_remote("hdmi", True), lambda: d.build_remote("home", 1),
    lambda: d.build_settings_set("1a", "k", B64), lambda: d.build_settings_set("a", "k", "not base64!"),
    lambda: d.build_settings_set("a", "k", "A" * 4001), lambda: d.build_settings_set(None, "k", B64),
    lambda: d.build_notify_toast(""), lambda: d.build_notify_toast("A" * 401), lambda: d.build_notify_toast(b"QUJD"),
    lambda: d.build_notify_say(B64, 100), lambda: d.build_notify_say(B64, -1), lambda: d.build_notify_say(B64, "5"),
    lambda: d.build_screenshot(1920, 1080, "gif"), lambda: d.build_screenshot("1920", 1080, "jpg"),
    lambda: d.build_screenshot(1, 1080, "jpg"), lambda: d.build_screenshot(True, 1080, "jpg"),
    lambda: d.build_stream_start(160, 90, 30, 0, 6), lambda: d.build_stream_start(160, 90, -1, 0, 2),
    lambda: d.build_process_image("1bad", 960, 540), lambda: d.build_process_image("ok", 96000, 540),
    lambda: d.build_process_audio("ai-sound", 100), lambda: d.build_process_audio("a b", 3),
    lambda: d.build_install("evil.sh"), lambda: d.build_install("not-a-real-file.sh"),
    lambda: d.build_app_install(""), lambda: d.build_app_install("A" * 1001), lambda: d.build_app_uninstall("a;id"),
    lambda: d.build_install_tree("../x/y", "put"), lambda: d.build_install_tree("/etc/passwd", "put"),
    lambda: d.build_install_tree("a/b", "exec"), lambda: d.build_install_tree(None, "put"),
    lambda: d.build_install_hook("rc.local"), lambda: d.build_run_hook("webos-foundry-x", "restart"),
])
def test_builders_reject_bad_arguments(call):
    with pytest.raises(ValidationError):
        call()


def test_whitelists():
    assert d.INSTALL_FILES == ("status.sh", "details.js", "notify.js", "settings.js", "remote.js",
                               "process-image.js", "process-audio.js", "apps.js", "dispatch.sh")
    assert {"hdmi", "wake", "volume"} <= set(d.REMOTE_ACTIONS) and len(set(d.REMOTE_ACTIONS)) == 15


@pytest.mark.parametrize("value", [0, 1, 40, 41, 99, 100])
def test_absolute_volume_builder(value):
    assert d.build_remote("volume", value) == "remote volume %d" % value
    assert d.verb_of(d.build_remote("volume", value)) == "remote"


@pytest.mark.parametrize("value", [None, True, False, 1.0, 1.5, -1, 101, "40", "40; id", "40\n", [], {}])
def test_absolute_volume_builder_rejects_invalid_values(value):
    with pytest.raises(ValidationError, match="Volume must be the integer 0-100"):
        d.build_remote("volume", value)
