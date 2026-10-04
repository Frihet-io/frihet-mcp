#!/usr/bin/env python3
"""Build the portable plugin from reviewed manifests and existing brand assets."""

import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / "marketplace/openai"
plugin = json.loads((source / "plugin.json").read_text())
bundle = root / "dist/openai-plugin"
archive = root / "dist" / f"{plugin['name']}-{plugin['version']}.zip"

# Explicit allowlist: reviewer credentials and unrelated files cannot enter the ZIP.
files = {
    "plugin.json": source / "plugin.json",
    "mcp.json": source / "mcp.json",
    **{
        f"assets/{name}.png": source / f"{name}.png"
        for name in ("frihet-composer", "frihet-composer-dark", "frihet-directory-dark")
    },
}
archive.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive, "w") as output:
    for name, path in sorted(files.items()):
        contents = path.read_bytes()
        target = bundle / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        output.writestr(info, contents)

print(archive)
