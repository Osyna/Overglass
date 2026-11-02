import subprocess
import json
import struct
import sys

import pytest

from tests.fakes import FakeTransport, make_assets
from webos_foundry import cli, dispatcher, process, tv
from webos_foundry.config import Config
from webos_foundry.errors import TransportError

POWER = {"returnValue": True, "state": "Active"}
STATUS_RAW = "\n".join(json.dumps(d) for d in (
    POWER, {"returnValue": True, "appId": "com.webos.app.hdmi1"}, {"main": "x"},
    {"temperature_millicelsius": 50000, "temperature_source": "soc"})) + "\n@@@\n" + json.dumps(
    {"returnValue": True, "volumeStatus": {"volume": 9, "maxVolume": 100, "muteStatus": True}})


@pytest.fixture
def paired(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path))
    Config.for_dir(tmp_path, tv_host="192.168.1.50", mac="AA:BB:CC:DD:EE:FF").save()
    return tmp_path


@pytest.fixture
def fake(monkeypatch, paired):
    transport = FakeTransport({"status": STATUS_RAW})
    monkeypatch.setattr(cli, "_transport", lambda args: transport)
    monkeypatch.setattr(cli, "SSHTransport", lambda config: transport)
    return transport


def wof(*argv):
    return cli.main(list(argv))


def test_cli_imports_standalone_without_loading_the_server():
    code = "import sys, webos_foundry.cli; assert 'webos_foundry.server' not in sys.modules"
    assert subprocess.run([sys.executable, "-c", code], capture_output=True).returncode == 0


@pytest.mark.parametrize("argv", [
    "pair --host 192.168.1.50 --root-key k --port 2222", "install --no-overlay --vtcap no", "install --tv-server", "update", "uninstall --yes",
    "doctor", "status --json", "details --json", "remote hdmi 2", "remote home", "settings list --json",
    "settings set sound aiSound on", "notify toast hi", "notify say hi --volume 10",
    "overlay show --title T --body B --line a --line b --image http://x/y.png --kind alert --position center --seconds 5",
    "overlay hide", "screenshot out.jpg --width 1280 --format png", "stream --bench 3 --size 160x90 --fps 10 --png o.png",
    "process image in.png out.png --profile standard", "process audio in.wav out.wav --profile clear-voice",
    "serve --host 0.0.0.0 --port 9 --token t --generate-token", "config show", "config set mac AA:BB:CC:DD:EE:FF",
])
def test_every_frozen_subcommand_parses(argv):
    args = cli.build_parser().parse_args(argv.split())
    assert callable(args.handler)


@pytest.mark.parametrize("argv", ["", "remote nope", "stream", "pair --host h", "notify", "process video a b", "settings"])
def test_parser_rejects_bad_invocations(argv):
    with pytest.raises(SystemExit) as info:
        cli.build_parser().parse_args(argv.split())
    assert info.value.code == 2


def test_status_json_and_human(fake, capsys):
    assert wof("status", "--json") == 0
    assert json.loads(capsys.readouterr().out)["source"] == "HDMI 1"
    assert wof("status") == 0
    out = capsys.readouterr().out
    assert "on (Active)" in out and "HDMI 1" in out and "9 (muted)" in out and "50.0 C (soc)" in out


def test_details(fake, capsys):
    details = {"lux": 3, "panel_hours": 1, "panel_temperature_c": None, "pixel_refresher": {}, "power_on_reason": "x",
               "power_history": [], "signal": {}, "sleep_timer": "off", "usage_today": []}
    fake.add("details", json.dumps(details))
    assert wof("details") == 0 and "Lux" in capsys.readouterr().out
    wof("details", "--json")
    assert json.loads(capsys.readouterr().out) == details


def test_remote_commands_and_wake(fake, monkeypatch, capsys):
    fake.add("remote", json.dumps({"message": "Sent home"}))
    assert wof("remote", "home") == 0 and wof("remote", "hdmi", "2") == 0
    assert fake.commands == ["remote home", "remote hdmi 2"]
    assert wof("remote", "hdmi", "x") == 1 and "HDMI input must be" in capsys.readouterr().err
    sent = []
    monkeypatch.setattr(tv, "_send_udp", lambda packet, address: sent.append(address))
    assert wof("remote", "wake") == 0 and sent == [("255.255.255.255", 9)]
    assert fake.commands == ["remote home", "remote hdmi 2"]


def test_settings_list_and_set_uses_the_tvs_context(fake, capsys):
    item = {"category": "sound", "key": "aiSound", "value": "on", "values": ["on", "off"], "available": True,
            "context": {"input": "hdmi"}}
    fake.add("settings-list", json.dumps([item]))
    fake.add("settings-set", json.dumps("aiSound = off (persists on the TV until changed)"))
    assert wof("settings", "list") == 0 and "AI Sound" in capsys.readouterr().out
    assert wof("settings", "set", "sound", "aiSound", "off") == 0
    assert "AI Sound: aiSound = off" in capsys.readouterr().out
    assert wof("settings", "set", "sound", "clearVoice", "on") == 1  # not reported by the TV
    assert wof("settings", "set", "sound", "bogus", "on") == 1


def test_notify_and_overlay(fake, capsys):
    fake.add("notify-toast", '{"returnValue": true}')
    fake.add("notify-say", '{"returnValue": true, "spoke": 2, "volume": 10}')
    fake.add("notify-overlay", '{"returnValue": true, "overlay": "shown"}')
    assert wof("notify", "toast", "hi") == 0 and wof("notify", "say", "yo", "--volume", "10") == 0
    assert fake.commands[1].endswith(" 10")
    assert wof("overlay", "show", "--title", "T", "--line", "a", "--line", "b", "--seconds", "0") == 0
    sent = json.loads(fake.calls[2].data)
    assert sent == {"seconds": 0, "root": {"type": "stack", "gap": 12, "children": [
        {"type": "row", "gap": 14, "align": "center", "children": [
            {"type": "dot", "tone": "info"}, {"type": "text", "text": "T", "size": "l", "weight": "strong"}]},
        {"type": "list", "items": ["a", "b"]},
    ]}}
    assert wof("overlay", "show", "--title", "T", "--size", "xl") == 0
    assert json.loads(fake.calls[3].data)["size"] == "xl"
    assert wof("overlay", "hide") == 0
    assert wof("overlay", "show") == 1 and "needs a title" in capsys.readouterr().err
    assert wof("notify", "say", "yo", "--volume", "99") == 1


def test_scene_set_list_run_delete(fake, tmp_path, capsys):
    scene_file = tmp_path / "scene.json"
    scene_file.write_text(json.dumps({"steps": [
        {"type": "remote", "action": "volume_down", "value": None},
        {"type": "overlay", "card": {"title": "Movie night", "seconds": 5}},
    ]}))
    assert wof("scene", "set", "movie-night", str(scene_file)) == 0
    assert "movie-night saved" in capsys.readouterr().out
    assert wof("scene", "list") == 0
    assert "movie-night (2 steps)" in capsys.readouterr().out
    fake.add("remote", '{"message": "Sent volume_down"}')
    fake.add("notify-overlay", '{"returnValue": true, "overlay": "shown"}')
    assert wof("scene", "run", "movie-night") == 0
    out = capsys.readouterr().out
    assert "Sent volume_down" in out and "Overlay card shown" in out
    assert wof("scene", "run", "nope") == 1
    assert wof("scene", "delete", "movie-night") == 0
    assert "movie-night deleted" in capsys.readouterr().out
    assert wof("scene", "delete", "movie-night") == 1


def test_scene_set_rejects_bad_json(fake, tmp_path, capsys):
    scene_file = tmp_path / "bad.json"
    scene_file.write_text(json.dumps({"steps": []}))
    assert wof("scene", "set", "x", str(scene_file)) == 1
    assert "needs 1-20 steps" in capsys.readouterr().err


def test_screenshot_infers_format_and_derives_height(fake, tmp_path):
    fake.add("screenshot", b"\x89PNG\r\n\x1a\nxx")
    out = tmp_path / "shot.png"
    assert wof("screenshot", str(out), "--width", "1280") == 0
    assert fake.commands == ["screenshot 1280 720 png"] and out.read_bytes().startswith(b"\x89PNG")
    fake.add("screenshot", b"\xff\xd8\xffxx")
    assert wof("screenshot", str(tmp_path / "a.jpg")) == 0 and fake.commands[-1] == "screenshot 1920 1080 jpg"


def test_stream_bench(fake, tmp_path, capsys):
    fake.stream = (b"C5F1" + struct.pack("<HH", 2, 2) + b"\x07" * 12 * 4, b"client done")
    out = tmp_path / "f.png"
    assert wof("stream", "--bench", "1", "--size", "16x10", "--fps", "5", "--png", str(out)) == 0
    text = capsys.readouterr().out
    assert "4 frames" in text and "client done" in text and out.read_bytes().startswith(b"\x89PNG")
    assert fake.commands[-1] == "stream-start 16 10 5 1 2"
    assert wof("stream", "--bench", "1", "--size", "bad") == 1


def test_stream_bench_too_few_frames(fake, capsys):
    fake.stream = (b"C5F1" + struct.pack("<HH", 2, 2) + b"\x07" * 12, b"vtcap said no")
    assert wof("stream", "--bench", "1", "--size", "16x10") == 1
    assert "vtcap said no" in capsys.readouterr().err


def test_process_commands(fake, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(process, "enhance_image", lambda t, i, o, p, **kw: calls.append(("image", i, o, p)) or {"ok": 1})
    monkeypatch.setattr(process, "enhance_audio", lambda t, i, o, p, **kw: calls.append(("audio", i, o, p)) or {"ok": 2})
    assert wof("process", "image", "a.png", "b.png") == 0 and wof("process", "audio", "a.wav", "b.wav", "--profile", "standard") == 0
    assert calls == [("image", "a.png", "b.png", "ai-picture-sr"), ("audio", "a.wav", "b.wav", "standard")]
    assert capsys.readouterr().out.splitlines() == ['{"ok": 1}', '{"ok": 2}']


def test_config_show_and_set(paired, capsys):
    assert wof("config", "show") == 0 and json.loads(capsys.readouterr().out)["tv_host"] == "192.168.1.50"
    assert wof("config", "set", "mac", "11:22:33:44:55:66") == 0 and wof("config", "set", "ssh_port", "2200") == 0
    assert wof("config", "set", "broadcast", "192.168.1.255:9") == 0 and wof("config", "set", "server_token", "abc") == 0
    config = Config.load()
    assert (config.mac, config.ssh_port, config.broadcast, config.server_token) == ("11:22:33:44:55:66", 2200, "192.168.1.255:9", "abc")
    assert wof("config", "set", "mac", "none") == 0 and Config.load().mac is None
    capsys.readouterr()
    for bad in (("mac", "zz"), ("ssh_port", "x"), ("ssh_port", "70000"), ("broadcast", "nope"), ("bogus", "1")):
        assert wof("config", "set", *bad) == 1
    assert Config.load().ssh_port == 2200


def test_config_set_creates_config_when_unpaired(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path / "new"))
    assert wof("config", "set", "tv_host", "192.168.1.9") == 0 and Config.load().tv_host == "192.168.1.9"


def test_config_dir_flag(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path / "env"))
    Config.for_dir(tmp_path / "flag", tv_host="flag-host").save(tmp_path / "flag")
    assert wof("--config-dir", str(tmp_path / "flag"), "config", "show") == 0
    assert json.loads(capsys.readouterr().out)["tv_host"] == "flag-host"


def test_unpaired_commands_point_at_pair(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path / "none"))
    assert wof("status") == 1
    assert "wof pair" in capsys.readouterr().err


def test_transport_error_is_one_line_exit_1(fake, capsys):
    fake.add("status", TransportError("TV did not answer within 12 s"))
    assert wof("status") == 1
    assert capsys.readouterr().err == "wof: TV did not answer within 12 s\n"


def test_install_update_uninstall(fake, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEBOS_FOUNDRY_ASSETS", str(make_assets(tmp_path / "assets")))
    for verb in ("install", "install-overlay", "uninstall-all"):
        fake.add(verb, b"")
    assert wof("install") == 0 and "Installed 9 files; overlay: True; vtcap: False" in capsys.readouterr().out
    assert wof("update") == 0 and "Updated 9 files" in capsys.readouterr().out
    monkeypatch.setattr("builtins.input", lambda prompt: "n")
    assert wof("uninstall") == 1 and "uninstall-all" not in fake.commands
    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    assert wof("uninstall") == 0 and "authorized_keys" in capsys.readouterr().out and fake.commands[-1] == "uninstall-all"
    fake.calls.clear()
    assert wof("uninstall", "--yes") == 0 and fake.commands == ["uninstall-all"]


def test_install_tv_server_flag_is_off_by_default_and_wired_through(fake, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEBOS_FOUNDRY_ASSETS", str(make_assets(tmp_path / "assets")))
    server = tmp_path / "tv-server"
    server.mkdir()
    (server / "server.js").write_bytes(b"//")
    (server / "init.d-hook.sh").write_bytes(b"#!/bin/sh\n")
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_bytes(b"<html>")
    monkeypatch.setenv("WEBOS_FOUNDRY_TV_SERVER", str(server))
    monkeypatch.setenv("WEBOS_FOUNDRY_WEB", str(web))
    for verb in ("install", "install-overlay", "install-tree", "install-hook"):
        fake.add(verb, b"")
    fake.add("run-hook", b"started\n")
    assert cli.build_parser().parse_args(["install"]).tv_server is False
    assert wof("install") == 0 and not any(c.startswith(("install-tree", "run-hook")) for c in fake.commands)
    capsys.readouterr()
    assert wof("install", "--tv-server") == 0
    out = capsys.readouterr().out
    assert "On-TV server installed (2 files)" in out and "8766" in out
    assert fake.commands[-1] == "run-hook webos-foundry-tv-server start"
    assert [c.split()[1] for c in fake.commands if c.startswith("install-tree")] == ["tv-server/server.js", "tv-server/web/index.html"]


def test_pair_command(monkeypatch, tmp_path, capsys):
    seen = {}

    def fake_pair(host, key, *, port, config_dir):
        seen.update(host=host, key=key, port=port, config_dir=config_dir)
        return Config(tv_host=host)

    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path))
    monkeypatch.setattr(cli.pairing, "pair", fake_pair)
    assert wof("pair", "--host", "192.168.1.50", "--root-key", "/k", "--port", "2222") == 0
    assert seen == {"host": "192.168.1.50", "key": "/k", "port": 2222, "config_dir": None}
    assert "Paired with 192.168.1.50" in capsys.readouterr().out


def test_doctor_reports_each_check(fake, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEBOS_FOUNDRY_ASSETS", str(make_assets(tmp_path / "assets")))
    monkeypatch.setattr(cli.shutil, "which", lambda tool: "/usr/bin/" + tool if tool != "ffmpeg" else None)
    (tmp_path / "id_ed25519").write_text("k")
    (tmp_path / "known_hosts").write_text("h")
    listing = {"files": {name: name != "notify.js" for name in dispatcher.INSTALL_FILES}, "overlay": False, "vtcap": False}
    fake.add("install-status", json.dumps(listing))
    assert wof("doctor") == 1  # notify.js missing
    out = capsys.readouterr().out
    assert "ok    ssh " in out and "warn  ffmpeg" in out and "FAIL  tv notify.js" in out and "ok    tv status" in out
    listing["files"]["notify.js"] = True
    fake.add("install-status", json.dumps(listing))
    assert wof("doctor") == 0


def test_doctor_fails_without_required_tools_or_config(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path / "none"))
    monkeypatch.setattr(cli.shutil, "which", lambda tool: None)
    assert wof("doctor") == 1
    out = capsys.readouterr().out
    assert "FAIL  ssh-keygen" in out and "FAIL  config" in out and "wof pair" in out


def test_doctor_tv_unreachable(fake, capsys):
    fake.add("status", TransportError("Connection refused"))
    assert wof("doctor") == 1 and "FAIL  tv " in capsys.readouterr().out


def test_serve_without_server_component(paired, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "webos_foundry.server", None)  # makes `from . import server` raise ImportError
    monkeypatch.delattr("webos_foundry.server", raising=False)
    assert wof("serve") == 1 and "web server component is not installed" in capsys.readouterr().err


def test_serve_forwards_flags_and_config_dir(paired, monkeypatch, tmp_path):
    import importlib
    monkeypatch.delitem(sys.modules, "webos_foundry.server", raising=False)
    server = importlib.import_module("webos_foundry.server")
    seen = {}
    monkeypatch.setattr(server, "main", lambda argv: seen.update(argv=argv, home=__import__("os").environ["WEBOS_FOUNDRY_HOME"]) or 0)
    assert wof("--config-dir", str(tmp_path / "x"), "serve", "--host", "0.0.0.0", "--port", "9", "--token", "t") == 0
    assert seen == {"argv": ["--host", "0.0.0.0", "--port", "9", "--token", "t"], "home": str(tmp_path / "x")}
    import os
    assert os.environ["WEBOS_FOUNDRY_HOME"] == str(paired)
    wof("serve", "--generate-token")
    assert seen["argv"][-1] == "--generate-token"


def test_webhook_create_list_delete(tmp_path, capsys):
    from webos_foundry import webhooks

    args = ("--config-dir", str(tmp_path))
    assert wof(*args, "webhook", "list") == 0
    assert "No webhooks saved yet" in capsys.readouterr().out
    assert wof(*args, "webhook", "create", "movie-night", "--label", "Movie night") == 0
    token, = webhooks.load(tmp_path)
    output = capsys.readouterr().out
    assert token in output and "/webhook/" + token in output
    assert wof(*args, "webhook", "list") == 0
    output = capsys.readouterr().out
    assert token in output and "movie-night" in output and "Movie night" in output
    assert wof(*args, "webhook", "list", "--json") == 0
    assert json.loads(capsys.readouterr().out) == {token: {"scene": "movie-night", "label": "Movie night"}}
    assert wof(*args, "webhook", "delete", token) == 0
    assert "Webhook deleted" in capsys.readouterr().out
    assert wof(*args, "webhook", "delete", token) == 1
    assert "No such webhook" in capsys.readouterr().err
    assert wof(*args, "webhook", "list", "--json") == 0
    assert json.loads(capsys.readouterr().out) == {}


def test_webhook_create_rejects_invalid_fields(tmp_path, capsys):
    args = ("--config-dir", str(tmp_path))
    assert wof(*args, "webhook", "create", "") == 1
    assert "scene name" in capsys.readouterr().err
    assert wof(*args, "webhook", "create", "scene", "--label", "x" * 61) == 1
    assert "webhook label" in capsys.readouterr().err


def test_connector_football_preview_and_show(monkeypatch, tmp_path, capsys):
    import io
    import urllib.request

    from webos_foundry import notify

    matches = [{"leagueName": "Bundesliga", "team1": {"teamName": "Home"},
                "team2": {"teamName": "Away"}, "matchResults": [],
                "matchDateTimeUTC": "2026-11-08T16:30:00Z"}]
    calls = []

    def urlopen(url, timeout):
        calls.append((url, timeout))
        return io.BytesIO(json.dumps(matches).encode())

    def no_transport(args):
        raise AssertionError("Preview must not need a TV or pairing")

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(cli, "_transport", no_transport)
    args = ("--config-dir", str(tmp_path / "unpaired"), "connector", "football")
    assert wof(*args) == 0
    body = json.loads(capsys.readouterr().out)
    assert notify.check_overlay_request(body) == body
    assert calls == [("https://api.openligadb.de/getmatchdata/bl1", 8)]

    transport = FakeTransport({"notify-overlay": '{"returnValue": true, "overlay": "shown"}'})
    monkeypatch.setattr(cli, "_transport", lambda args: transport)
    assert wof(*args, "--league", "bl2", "--show") == 0
    assert capsys.readouterr().out.strip() == "Overlay card shown"
    assert calls[-1] == ("https://api.openligadb.de/getmatchdata/bl2", 8)
    assert json.loads(transport.calls[0].data) == body


def test_connector_network_error_is_cli_error(monkeypatch, capsys):
    import urllib.error
    import urllib.request

    def urlopen(url, timeout):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert wof("connector", "football") == 1
    assert "wof: Could not fetch OpenLigaDB football data" in capsys.readouterr().err


def test_schedule_set_list_update_delete(tmp_path, capsys):
    args = ("--config-dir", str(tmp_path / "schedule-home"))
    assert wof(*args, "schedule", "list") == 0
    assert "No schedule entries" in capsys.readouterr().out
    assert wof(*args, "schedule", "set", "future-scene", "20:00", "--days", "mon,tue") == 0
    saved = capsys.readouterr().out
    assert "saved" in saved
    assert wof(*args, "schedule", "list", "--json") == 0
    entries = json.loads(capsys.readouterr().out)
    entry_id, = entries
    assert entry_id in saved
    assert entries[entry_id] == {"id": entry_id, "scene": "future-scene", "time": "20:00",
                                 "days": ["mon", "tue"], "enabled": True}
    assert wof(*args, "schedule", "list") == 0
    listed = capsys.readouterr().out
    assert all(value in listed for value in (entry_id, "future-scene", "20:00", "mon,tue", "enabled=true"))
    assert wof(*args, "schedule", "set", "--id", entry_id, "later", "23:59", "--disabled") == 0
    capsys.readouterr()
    assert wof(*args, "schedule", "list", "--json") == 0
    assert json.loads(capsys.readouterr().out) == {
        entry_id: {"id": entry_id, "scene": "later", "time": "23:59", "days": [], "enabled": False},
    }
    assert wof(*args, "schedule", "delete", entry_id) == 0
    assert entry_id in capsys.readouterr().out
    assert wof(*args, "schedule", "list", "--json") == 0
    assert json.loads(capsys.readouterr().out) == {}
    assert wof(*args, "schedule", "delete", entry_id) == 1
    assert "No such schedule entry" in capsys.readouterr().err


def test_schedule_set_rejects_invalid_entries(tmp_path, capsys):
    args = ("--config-dir", str(tmp_path))
    assert wof(*args, "schedule", "set", "s", "24:00") == 1
    assert "HH:MM" in capsys.readouterr().err
    assert wof(*args, "schedule", "set", "s", "20:00", "--days", "Mon") == 1
    assert "days" in capsys.readouterr().err
    assert wof(*args, "schedule", "set", "--id", "missing", "s", "20:00") == 1
    assert "No such schedule entry" in capsys.readouterr().err


def test_schedule_help_lists_three_subcommands(capsys):
    with pytest.raises(SystemExit) as exit_info:
        cli.build_parser().parse_args(["schedule", "--help"])
    assert exit_info.value.code == 0
    help_text = capsys.readouterr().out
    assert all(command in help_text for command in ("list", "set", "delete"))
