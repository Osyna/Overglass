import json
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
ZBAR = shutil.which("zbarimg")
LIBRARY = Path(__file__).resolve().parents[1] / "tv-assets" / "overlay" / "qrcode.js"


@pytest.mark.skipif(not NODE or not ZBAR, reason="Node and zbarimg needed for independent QR decoder proof")
@pytest.mark.parametrize("text", ["https://webosfoundry.dev/design?name=match", "Dîner prêt — 你好 ✓"])
def test_vendored_qr_roundtrips_through_independent_scanner(tmp_path, text):
    script = """const qr=require(process.argv[1])(0,'L'); qr.addData(process.argv[2], 'Byte'); qr.make();
const n=qr.getModuleCount(); console.log(JSON.stringify(Array.from({length:n},(_,r)=>Array.from({length:n},(_,c)=>qr.isDark(r,c)))));"""
    output = subprocess.run([NODE, "-e", script, str(LIBRARY), text], check=True, capture_output=True, text=True)
    matrix = json.loads(output.stdout)
    scale, quiet = 8, 4
    side = (len(matrix) + 2 * quiet) * scale
    pixels = bytearray()
    for row in range(side):
        for column in range(side):
            r, c = row // scale - quiet, column // scale - quiet
            dark = 0 <= r < len(matrix) and 0 <= c < len(matrix) and matrix[r][c]
            pixels.append(0 if dark else 255)
    image = tmp_path / "qr.pgm"
    image.write_bytes(("P5\n%d %d\n255\n" % (side, side)).encode() + pixels)
    result = subprocess.run([ZBAR, "--quiet", "--raw", "--set", "*.enable=0", "--set", "qrcode.enable=1", str(image)],
                            check=True, capture_output=True, text=True, encoding="utf-8")
    assert result.stdout.rstrip("\n") == text
