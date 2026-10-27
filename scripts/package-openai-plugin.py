#!/usr/bin/env python3
"""Build the portable plugin from reviewed manifests, bundled skills, and existing brand assets."""

import json
from pathlib import Path
import shutil
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / "marketplace/openai"
plugin = json.loads((source / "plugin.json").read_text())
bundle = source / "dist/openai-plugin"
archive = source / "dist" / f"{plugin['name']}-{plugin['version']}.zip"

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
