#!/usr/bin/env python3
"""Build the portable plugin from reviewed manifests, bundled skills, and existing brand assets."""

import hashlib
import json
from pathlib import Path
import shutil
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / "marketplace/openai"
plugin = json.loads((source / "plugin.json").read_text())
mcp = json.loads((source / "mcp.json").read_text())
bundle = source / "dist/openai-plugin"
stem = f"{plugin['name']}-{plugin['version']}"
archive = source / "dist" / f"{stem}.zip"
checksum_file = source / "dist" / f"{stem}.zip.sha256"
inventory_file = source / "dist" / f"{stem}-inventory.json"

SKILLS = (
    "frihet-workspace",
    "invoices-and-quotes",
    "expenses-and-vendors",
    "clients-crm",
)

# Explicit allowlist: reviewer credentials and unrelated files cannot enter the ZIP.
files = {
    "plugin.json": source / "plugin.json",
    "mcp.json": source / "mcp.json",
    **{
        f"assets/{name}.png": source / f"{name}.png"
        for name in ("frihet-composer", "frihet-composer-dark", "frihet-directory-dark")
    },
    **{
        f"skills/{skill}/SKILL.md": source / "skills" / skill / "SKILL.md"
        for skill in SKILLS
    },
}

onboarding = plugin.get("extensions", {}).get("com.openai", {}).get("onboardingSkill", "")
if not onboarding.startswith("./") or onboarding.removeprefix("./") not in files:
    raise RuntimeError(f"onboardingSkill must point to a packaged skill file, got {onboarding!r}")

if bundle.exists():
    shutil.rmtree(bundle)
archive.parent.mkdir(parents=True, exist_ok=True)
entries = []
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
        entries.append(
            {
                "path": name,
                "sizeBytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
            }
        )

archive_bytes = archive.read_bytes()
archive_sha256 = hashlib.sha256(archive_bytes).hexdigest()
checksum_file.write_text(f"{archive_sha256}  {archive.name}\n", encoding="utf-8")
inventory = {
    "name": plugin["name"],
    "version": plugin["version"],
    "zipFile": archive.name,
    "zipSizeBytes": len(archive_bytes),
    "zipSha256": archive_sha256,
    "onboardingSkill": onboarding,
    "mcpEndpoint": mcp["mcpServers"]["frihet"]["url"],
    "fileCount": len(entries),
    "files": entries,
}
inventory_file.write_text(f"{json.dumps(inventory, indent=2)}\n", encoding="utf-8")

print(archive)
