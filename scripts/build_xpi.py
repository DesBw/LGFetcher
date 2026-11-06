#!/usr/bin/env python3
"""Build an installable LGFetcher XPI without including development files."""

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_FILES = (
    "manifest.json",
    "bootstrap.js",
    "icon.svg",
    "preferences-default.js",
    "preferences-ui.js",
    "preferences.xhtml",
    "selection.js",
    "selection.xhtml",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", help="Output XPI path (default: dist/LGFetcher-<version>.xpi)")
    args = parser.parse_args()

    with (ROOT / "manifest.json").open(encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
    version = manifest["version"]
    zotero = manifest["applications"]["zotero"]
    for field in ("id", "strict_min_version", "strict_max_version"):
        if not zotero.get(field):
            raise SystemExit(f"manifest.json is missing applications.zotero.{field}")
    if not zotero.get("update_url", "").startswith("https://"):
        raise SystemExit("manifest.json needs an HTTPS applications.zotero.update_url for Zotero to install it")
    output = Path(args.output) if args.output else ROOT / "dist" / f"LGFetcher-{version}.xpi"
    output.parent.mkdir(parents=True, exist_ok=True)

    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name in PLUGIN_FILES:
            archive.write(ROOT / name, arcname=name)
    print(output.resolve())


if __name__ == "__main__":
    main()
