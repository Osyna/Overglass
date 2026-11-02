import pytest

from webos_foundry import dispatcher as d
from webos_foundry.errors import ValidationError

B64 = "QUJD"

# verb -> (strings the TV-side grammar must accept, strings it must reject)
CASES = {
    "status": (["status"], ["status ", "status x", "Status", ""]),
    "details": (["details"], ["details 1", "detail"]),
    "remote": (["remote home", "remote wake", "remote volume_down", "remote hdmi 1", "remote hdmi 4"],
               ["remote hdmi", "remote hdmi 0", "remote hdmi 5", "remote hdmi 12", "remote nope", "remote home 1",
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
    "notify-overlay": (["notify-overlay " + B64, "notify-overlay " + "A" * 8000],
                       ["notify-overlay", "notify-overlay " + "A" * 8001, "notify-overlay a b"]),
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
    "install": (["install dispatch.sh " + B64, "install status.sh QQ==", "install process-audio.js QUJDRA=="],
                ["install evil.sh " + B64, "install ../dispatch.sh " + B64, "install dispatch.sh", "install dispatch.sh !!",
                 "install dispatch.sh QQ===", "install dispatch.sh " + B64 + "\n", "install statusXsh " + B64]),
    "install-overlay": (["install-overlay " + B64, "install-overlay QQ=="], ["install-overlay", "install-overlay *"]),
    "uninstall-overlay": (["uninstall-overlay"], ["uninstall-overlay now"]),
    "install-vtcap": (["install-vtcap " + B64], ["install-vtcap", "install-vtcap a b"]),
    "uninstall-vtcap": (["uninstall-vtcap"], ["uninstall-vtcap x"]),
    "uninstall-all": (["uninstall-all"], ["uninstall-all x"]),
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
        d.build_notify_say(B64), d.build_notify_say(B64, 20), d.build_notify_overlay(B64),
        d.build_screenshot(1920, 1080, "png"), d.build_stream_start(160, 90, 30, 0, 2),
        d.build_process_image("standard", 960, 540), d.build_process_audio("ai-sound", 3), d.build_idle_wait(),
        d.build_install_status(), d.build_install("notify.js", B64), d.build_install_overlay(B64),
        d.build_uninstall_overlay(), d.build_install_vtcap(B64), d.build_uninstall_vtcap(), d.build_uninstall_all(),
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
    lambda: d.build_notify_overlay("A" * 8001),
    lambda: d.build_screenshot(1920, 1080, "gif"), lambda: d.build_screenshot("1920", 1080, "jpg"),
    lambda: d.build_screenshot(1, 1080, "jpg"), lambda: d.build_screenshot(True, 1080, "jpg"),
    lambda: d.build_stream_start(160, 90, 30, 0, 6), lambda: d.build_stream_start(160, 90, -1, 0, 2),
    lambda: d.build_process_image("1bad", 960, 540), lambda: d.build_process_image("ok", 96000, 540),
    lambda: d.build_process_audio("ai-sound", 100), lambda: d.build_process_audio("a b", 3),
    lambda: d.build_install("evil.sh", B64), lambda: d.build_install("dispatch.sh", ""),
    lambda: d.build_install_overlay(""), lambda: d.build_install_vtcap("a b"),
])
def test_builders_reject_bad_arguments(call):
    with pytest.raises(ValidationError):
        call()


def test_whitelists():
    assert d.INSTALL_FILES == ("status.sh", "details.js", "notify.js", "settings.js", "remote.js",
                               "process-image.js", "process-audio.js", "dispatch.sh")
    assert "hdmi" in d.REMOTE_ACTIONS and "wake" in d.REMOTE_ACTIONS and len(set(d.REMOTE_ACTIONS)) == 14
