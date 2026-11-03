#!/usr/bin/env python3
"""Build the CLI/web UI release ZIP, installable Python packages, and webOS overlay IPK."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="new or empty release output directory")
    args = parser.parse_args()
    out = args.out.resolve()
    if out.exists() and any(out.iterdir()):
        parser.error("release output directory must be empty: %s" % out)
    out.mkdir(parents=True, exist_ok=True)
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    version = project["version"]

    subprocess.run([sys.executable, "-m", "build", "--outdir", str(out), str(ROOT)], check=True)

    app = json.loads((ROOT / "tv-assets/overlay/appinfo.json").read_text())
    from webos_foundry import install

    ipk = "dev.webosfoundry.overlay_%s_all.ipk" % app["version"]
    package = install.package_overlay(ROOT / "tv-assets/overlay")
    install._checked(package)
    (out / ipk).write_bytes(package)

    stage = out / ("Overglass-%s" % version)
    stage.mkdir()
    for source in ("webos_foundry", "web", "tv-assets", "tv-server"):
        shutil.copytree(ROOT / source, stage / source,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(ROOT / "LICENSE", stage / "LICENSE")
    (stage / "README.txt").write_text(
        "Overglass %s\n\nRun the CLI with: python3 -m webos_foundry.cli --help\n"
        "Start the browser UI and server with: python3 -m webos_foundry.server\n"
        "The server opens at http://127.0.0.1:8765/.\n" % version)
    with zipfile.ZipFile(out / ("Overglass-%s.zip" % version), "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(stage.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(out))
    shutil.rmtree(stage)

    files = sorted(path for path in out.iterdir() if path.is_file() and path.name != "SHA256SUMS")
    (out / "SHA256SUMS").write_text("".join(
        "%s  %s\n" % (hashlib.sha256(path.read_bytes()).hexdigest(), path.name) for path in files))
    for path in files:
        print("%s  %d bytes" % (path.name, path.stat().st_size))
    print("SHA256SUMS")


if __name__ == "__main__":
    main()
