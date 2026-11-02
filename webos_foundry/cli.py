"""`wof`: one subcommand per capability."""
import argparse
import json
import os
import shutil
import sys
import time
from dataclasses import asdict, fields
from pathlib import Path

from . import capture, connectors, dispatcher, install as install_module, notify, pairing, process, scenes, schedule, tv, webhooks
from .config import ENV, Config, config_dir
from .errors import ConfigError, ValidationError, WebosFoundryError
from .transport import SSHTransport

OPTIONAL_KEYS = ("mac", "broadcast", "server_token")


def _config(args):
    return Config.require(args.config_dir)


def _transport(args):
    """The only place the CLI builds a real transport (tests replace it)."""
    return SSHTransport(_config(args))


def _emit(args, value, human):
    print(json.dumps(value, indent=2) if args.json else human(value))


def _kv(pairs):
    return "\n".join("%-16s %s" % (key + ":", "-" if value is None else value) for key, value in pairs)


def _human_status(s):
    volume = "-" if s["volume"] is None else "%s%s" % (s["volume"], " (muted)" if s["muted"] else "")
    temperature = "-" if s["temperature_c"] is None else "%.1f C (%s)" % (s["temperature_c"], s["temperature_source"])
    return _kv([("Power", "%s (%s)" % (s["power"], s["raw_power_state"])), ("Source", s["source"]),
                ("App", s["app_id"]), ("Luma", s["is_luma"]), ("Temperature", temperature), ("Volume", volume)])


def _human_details(d):
    return _kv([(key.replace("_", " ").capitalize(), json.dumps(value) if isinstance(value, (dict, list)) else value)
                for key, value in d.items()])


def _human_settings(items):
    rows = [("%s.%s" % (i["category"], i["key"]), i["label"], i["value"], i["available"], ", ".join(i["values"]))
            for i in items]
    return "\n".join("%-24s %-18s %-16s %s  [%s]" % (key, label, value, "ok " if available else "n/a", values)
                     for key, label, value, available, values in rows)


def cmd_pair(args):
    config = pairing.pair(args.host, args.root_key, port=args.port, config_dir=args.config_dir)
    print("Paired with %s and installed the TV assets. Config: %s" % (
        config.tv_host, config_dir(args.config_dir) / "config.json"))


def cmd_install(args):
    result = install_module.install(_transport(args), overlay=not args.no_overlay, vtcap=args.vtcap,
                                    tv_server=args.tv_server)
    print("Installed %d files; overlay: %s; vtcap: %s" % (len(result["files"]), result["overlay"], result["vtcap"]))
    if args.tv_server:
        print("On-TV server installed (%d files) and started. Its token is generated on first start and printed to "
              "/tmp/webos-foundry-tv-server.log; reach it at http://<tv-address>:8766/ (see docs/TV-SERVER.md)."
              % len(result["tv_server"]["files"]))


def cmd_update(args):
    print("Updated %d files" % len(install_module.update(_transport(args))["files"]))


def cmd_uninstall(args):
    if not args.yes:
        if input("Remove every webOS Foundry file from the TV? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Aborted")
            return 1
    print(install_module.uninstall(_transport(args))["note"])


def _doctor_checks(args):
    """Yields (label, ok, detail); ok None marks an optional tool that is missing (a warning)."""
    for tool, needed in (("ssh", True), ("ssh-keygen", True), ("ffmpeg", False), ("ffprobe", False)):
        found = shutil.which(tool)
        yield tool, True if found else (False if needed else None), found or (
            "required" if needed else "optional: needed by `wof process image`")
    try:
        yield "assets", True, str(install_module.assets_dir())
    except FileNotFoundError as error:
        yield "assets", False, str(error)
    try:
        config = _config(args)
    except WebosFoundryError as error:
        yield "config", False, str(error)
        return
    yield "config", True, "%s:%d" % (config.tv_host, config.ssh_port)
    for label, path in (("key", config.key_path), ("known_hosts", config.known_hosts_path)):
        yield label, Path(path).is_file(), path
    try:
        transport = SSHTransport(config)
        yield "tv status", True, tv.get_status(transport)["power"]
        installed = install_module.status(transport)
        for name, present in installed["files"].items():
            yield "tv " + name, present, "installed" if present else "missing (run `wof update`)"
        for name in ("overlay", "vtcap"):
            yield "tv " + name, True, "installed" if installed[name] else "not installed (optional)"
    except (WebosFoundryError, RuntimeError, ValueError) as error:
        yield "tv", False, str(error)


def cmd_doctor(args):
    failed = False
    for label, ok, detail in _doctor_checks(args):
        failed = failed or ok is False
        print("%-5s %-16s %s" % ({True: "ok", False: "FAIL", None: "warn"}[ok], label, detail))
    return 1 if failed else 0


def cmd_status(args):
    _emit(args, tv.get_status(_transport(args)), _human_status)


def cmd_details(args):
    _emit(args, tv.get_details(_transport(args)), _human_details)


def _remote_value(action, value):
    if value is None or action != "hdmi":
        return value
    try:
        return int(value)
    except ValueError:
        raise ValidationError("HDMI input must be the integer 1-4") from None


def cmd_remote(args):
    config = _config(args)
    print(tv.remote(SSHTransport(config), args.action, _remote_value(args.action, args.value), config=config))


def cmd_settings_list(args):
    _emit(args, tv.get_settings(_transport(args)), _human_settings)


def cmd_settings_set(args):
    transport = _transport(args)
    item = next((i for i in tv.get_settings(transport) if (i["category"], i["key"]) == (args.category, args.key)), None)
    if item is None:
        raise ValidationError("Unsupported setting")
    print(tv.set_setting(transport, args.category, args.key, args.value, item["context"]))


def cmd_notify_toast(args):
    print(notify.toast(_transport(args), args.text))


def cmd_notify_say(args):
    print(notify.say(_transport(args), args.text, args.volume))


def cmd_overlay_show(args):
    card = {"title": args.title, "body": args.body, "lines": args.line or None, "image": args.image,
            "kind": args.kind, "position": args.position, "seconds": args.seconds}
    print(notify.overlay_show(_transport(args), {key: value for key, value in card.items() if value is not None}))


def cmd_overlay_hide(args):
    print(notify.overlay_hide(_transport(args)))


def cmd_scene_list(args):
    saved = scenes.load(args.config_dir)
    if args.json:
        print(json.dumps(saved, indent=2))
    elif not saved:
        print("No scenes saved yet; see `wof scene set --help`")
    else:
        for name, scene in sorted(saved.items()):
            print("%s (%d step%s)" % (name, len(scene["steps"]), "" if len(scene["steps"]) == 1 else "s"))


def cmd_scene_set(args):
    text = sys.stdin.read() if args.file == "-" else Path(args.file).read_text()
    scenes.save(args.name, scenes.check_scene(json.loads(text)), args.config_dir)
    print("Scene %s saved" % args.name)


def cmd_scene_delete(args):
    scenes.delete(args.name, args.config_dir)
    print("Scene %s deleted" % args.name)


def cmd_scene_run(args):
    saved = scenes.load(args.config_dir)
    if args.name not in saved:
        raise ValidationError("No such scene: %s" % args.name)
    for message in scenes.run_scene(_transport(args), saved[args.name]):
        print(message)


def cmd_connector(args):
    params = {"league": args.league}
    if args.show:
        print(connectors.run(args.connector, params, _transport(args)))
    else:
        print(json.dumps(connectors.CONNECTORS[args.connector](params), indent=2))


def cmd_schedule_list(args):
    entries = schedule.load(args.config_dir)
    if args.json:
        print(json.dumps(entries, indent=2))
    elif not entries:
        print("No schedule entries saved yet; see `wof schedule set --help`")
    else:
        for entry_id, entry in sorted(entries.items()):
            print("%s  %s  %s  %s  enabled=%s" %
                  (entry_id, entry["scene"], entry["time"], ",".join(entry["days"]) or "every day",
                   str(entry["enabled"]).lower()))


def cmd_schedule_set(args):
    entry = {"scene": args.scene, "time": args.time, "days": args.days.split(",") if args.days else [],
             "enabled": not args.disabled}
    entry_id = schedule.save(args.id, entry, args.config_dir)
    print("Schedule entry %s saved" % entry_id)


def cmd_schedule_delete(args):
    schedule.delete(args.id, args.config_dir)
    print("Schedule entry %s deleted" % args.id)


def cmd_webhook_list(args):
    saved = webhooks.load(args.config_dir)
    if args.json:
        print(json.dumps(saved, indent=2))
    elif not saved:
        print("No webhooks saved yet; see `wof webhook create --help`")
    else:
        for token, entry in sorted(saved.items()):
            print("%s  %s  %s" % (token, entry["scene"], entry["label"]))


def cmd_webhook_create(args):
    token = webhooks.create(args.scene, args.label, args.config_dir)
    print("Webhook created: %s\n/webhook/%s" % (token, token))


def cmd_webhook_delete(args):
    webhooks.delete(args.token, args.config_dir)
    print("Webhook deleted")


def cmd_screenshot(args):
    out = Path(args.out)
    fmt = args.format or ("png" if out.suffix.lower() == ".png" else "jpg")
    data, _ = capture.screenshot(_transport(args), args.width, args.width * 9 // 16, fmt)
    out.write_bytes(data)
    print("Saved %s (%d bytes)" % (out, len(data)))


def _size(text):
    try:
        width, height = (int(part) for part in text.split("x"))
    except ValueError:
        raise ValidationError("Size must look like 160x90") from None
    return width, height


def cmd_stream(args):
    width, height = _size(args.size)
    info, stamps, last, first = {}, [], None, None
    for w, h, frame in capture.stream(_transport(args), width, height, args.fps, args.bench, info=info):
        now = time.monotonic()
        first = first or now
        stamps.append(now)
        last = (w, h, frame)
        if now - first >= args.bench:
            break
    if len(stamps) < 2:
        raise RuntimeError("Fewer than two frames arrived: " + (info.get("stats") or "no client output"))
    span = stamps[-1] - stamps[0]
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    print("%d frames in %.2f s = %.1f fps; interval mean %.1f ms, max %.0f ms" % (
        len(stamps), span, (len(stamps) - 1) / span, 1000 * span / len(gaps), 1000 * max(gaps)))
    if info.get("stats"):
        print("client stats: " + info["stats"])
    Path(args.png).write_bytes(capture.png(*last))
    print("saved " + args.png)


def cmd_process(args):
    run = process.enhance_image if args.kind == "image" else process.enhance_audio
    profiles = process.IMAGE_PROFILES if args.kind == "image" else process.AUDIO_PROFILES
    result = run(_transport(args), args.input, args.output, args.profile or profiles[0],
                 log=lambda message: print(message, file=sys.stderr))
    print(json.dumps(result))


def cmd_serve(args):
    try:
        from . import server
    except ImportError:
        print("wof: the web server component is not installed", file=sys.stderr)
        return 1
    argv = ["--host", args.host, "--port", str(args.port)]
    if args.token:
        argv += ["--token", args.token]
    if args.generate_token:
        argv.append("--generate-token")
    previous = os.environ.get(ENV)
    if args.config_dir:
        os.environ[ENV] = str(args.config_dir)
    try:
        return server.main(argv)
    finally:
        if previous is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = previous


def cmd_config_show(args):
    print(json.dumps(asdict(Config.load(args.config_dir)), indent=2))


def cmd_config_set(args):
    names = [f.name for f in fields(Config)]
    if args.key not in names:
        raise ValidationError("Unknown config key; choose one of " + ", ".join(names))
    try:
        config = Config.load(args.config_dir)
    except ConfigError:
        if (config_dir(args.config_dir) / "config.json").exists():
            raise
        config = Config.for_dir(config_dir(args.config_dir))
    value = args.value
    if args.key in OPTIONAL_KEYS and value.lower() in ("", "none", "null"):
        value = None
    elif args.key == "ssh_port":
        if not value.isdigit() or not 1 <= int(value) <= 65535:
            raise ValidationError("ssh_port must be an integer 1-65535")
        value = int(value)
    elif args.key == "mac":
        tv.magic_packet(value)
    elif args.key == "broadcast":
        tv._broadcast_address(value)
    setattr(config, args.key, value)
    config.save(args.config_dir)
    print("%s set" % args.key)


def build_parser():
    parser = argparse.ArgumentParser(prog="wof", description="Control a rooted LG webOS TV")
    parser.add_argument("--config-dir", help="config directory (default $%s or ~/.config/webos-foundry)" % ENV)
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    def add(name, handler, help_text, parent=commands, **kwargs):
        command = parent.add_parser(name, help=help_text, description=help_text, **kwargs)
        command.set_defaults(handler=handler)
        return command

    def with_json(command):
        command.add_argument("--json", action="store_true", help="print raw JSON")
        return command

    command = add("pair", cmd_pair, "pair with the TV using your existing root key (needs ssh-keygen)")
    command.add_argument("--host", required=True)
    command.add_argument("--root-key", required=True, help="the SSH key you already use as root on the TV")
    command.add_argument("--port", type=int, default=22)

    command = add("install", cmd_install, "install the TV-side files")
    command.add_argument("--no-overlay", action="store_true")
    command.add_argument("--vtcap", choices=("auto", "yes", "no"), default="auto")
    command.add_argument("--tv-server", action="store_true",
                         help="also install and start the web server that runs on the TV itself (port 8766)")
    add("update", cmd_update, "re-push the TV-side scripts")
    command = add("uninstall", cmd_uninstall, "remove everything webOS Foundry put on the TV")
    command.add_argument("--yes", action="store_true")
    add("doctor", cmd_doctor, "check tools, config and the TV")
    with_json(add("status", cmd_status, "power, source, temperature, volume"))
    with_json(add("details", cmd_details, "lux, panel, usage and other read-only sensors"))

    command = add("remote", cmd_remote, "send a remote action")
    command.add_argument("action", choices=dispatcher.REMOTE_ACTIONS)
    command.add_argument("value", nargs="?", help="HDMI input 1-4 for `hdmi`")

    settings = add("settings", None, "AI picture/sound settings").add_subparsers(dest="sub", required=True, metavar="SUB")
    with_json(add("list", cmd_settings_list, "list settings", settings))
    command = add("set", cmd_settings_set, "change one setting", settings)
    command.add_argument("category")
    command.add_argument("key")
    command.add_argument("value")

    group = add("notify", None, "toast or spoken message").add_subparsers(dest="sub", required=True, metavar="SUB")
    command = add("toast", cmd_notify_toast, "on-screen toast", group)
    command.add_argument("text")
    command = add("say", cmd_notify_say, "speak through the TV speaker", group)
    command.add_argument("text")
    command.add_argument("--volume", type=int, default=15, help="1-40 (default 15)")

    group = add("overlay", None, "on-screen card").add_subparsers(dest="sub", required=True, metavar="SUB")
    command = add("show", cmd_overlay_show, "show a card", group)
    command.add_argument("--title")
    command.add_argument("--body")
    command.add_argument("--line", action="append", help="repeatable")
    command.add_argument("--image", metavar="URL")
    command.add_argument("--kind", choices=("info", "success", "warning", "alert"))
    command.add_argument("--position", choices=("top-left", "top-right", "bottom-left", "bottom-right", "center"))
    command.add_argument("--seconds", type=int, help="0-300; 0 = until hidden")
    add("hide", cmd_overlay_hide, "hide the card", group)

    group = add("scene", None, "named sequences of remote/setting/overlay/wait steps").add_subparsers(
        dest="sub", required=True, metavar="SUB")
    with_json(add("list", cmd_scene_list, "list saved scenes", group))
    command = add("set", cmd_scene_set, "save a scene from a JSON file: {\"steps\": [...]}", group)
    command.add_argument("name")
    command.add_argument("file", metavar="FILE.json", help="- for stdin")
    command = add("delete", cmd_scene_delete, "remove a saved scene", group)
    command.add_argument("name")
    command = add("run", cmd_scene_run, "run every step of a saved scene, in order", group)
    command.add_argument("name")

    group = add("schedule", None, "local-time scene schedules (requires wof serve)").add_subparsers(
        dest="sub", required=True, metavar="SUB")
    with_json(add("list", cmd_schedule_list, "list saved schedule entries", group))
    command = add("set", cmd_schedule_set, "create or replace a schedule entry", group)
    command.add_argument("--id", help="existing entry ID to replace; omit to create")
    command.add_argument("scene")
    command.add_argument("time", metavar="HH:MM")
    command.add_argument("--days", help="comma-separated mon,tue,wed,thu,fri,sat,sun; default every day")
    command.add_argument("--disabled", action="store_true")
    command = add("delete", cmd_schedule_delete, "remove a schedule entry", group)
    command.add_argument("id")

    group = add("webhook", None, "revocable URLs that run one saved scene").add_subparsers(
        dest="sub", required=True, metavar="SUB")
    with_json(add("list", cmd_webhook_list, "list webhook tokens, scenes and labels", group))
    command = add("create", cmd_webhook_create, "create a public trigger URL for a scene", group)
    command.add_argument("scene")
    command.add_argument("--label", help="display label (at most 60 characters)")
    command = add("delete", cmd_webhook_delete, "revoke a webhook URL", group)
    command.add_argument("token")

    group = add("connector", None, "external data overlay cards").add_subparsers(
        dest="connector", required=True, metavar="CONNECTOR")
    command = add("football", cmd_connector, "current-matchday football scores from OpenLigaDB", group)
    command.add_argument("--league", default="bl1", help="OpenLigaDB league shortcut (default bl1)")
    command.add_argument("--show", action="store_true", help="show the card on the TV instead of printing JSON")

    command = add("screenshot", cmd_screenshot, "capture the HDMI picture")
    command.add_argument("out", metavar="OUT.jpg")
    command.add_argument("--width", type=int, default=1920)
    command.add_argument("--format", choices=("jpg", "png"))

    command = add("stream", cmd_stream, "benchmark the live frame stream")
    command.add_argument("--bench", type=int, required=True, metavar="SECONDS")
    command.add_argument("--size", default="160x90", help="WxH (default 160x90)")
    command.add_argument("--fps", type=int, default=30)
    command.add_argument("--png", default="/tmp/wof-frame.png", metavar="OUT.png")

    group = add("process", None, "run a file through the TV's picture/sound engine").add_subparsers(
        dest="kind", required=True, metavar="KIND")
    for kind in ("image", "audio"):
        command = add(kind, cmd_process, "process %s" % kind, group)
        command.add_argument("input")
        command.add_argument("output")
        command.add_argument("--profile", choices=process.IMAGE_PROFILES if kind == "image" else process.AUDIO_PROFILES)

    command = add("serve", cmd_serve, "HTTP API and web UI")
    command.add_argument("--host", default="127.0.0.1")
    command.add_argument("--port", type=int, default=8765)
    command.add_argument("--token")
    command.add_argument("--generate-token", action="store_true")

    group = add("config", None, "show or change the config").add_subparsers(dest="sub", required=True, metavar="SUB")
    add("show", cmd_config_show, "print the config", group)
    command = add("set", cmd_config_set, "set one config value", group)
    command.add_argument("key")
    command.add_argument("value")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args) or 0
    except KeyboardInterrupt:
        return 130
    except (WebosFoundryError, ValueError, RuntimeError, OSError) as error:
        print("wof: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
