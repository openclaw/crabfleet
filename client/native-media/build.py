#!/usr/bin/env python3
"""Build the pinned DTLS plugin into target/, without installing system files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Use verified cached sources only")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    manifest = json.loads((source / "sources.json").read_text())
    output = source.parent / "target" / "native-media"
    cache = output / "sources"
    cache.mkdir(parents=True, exist_ok=True)
    version = subprocess.check_output(
        ["pkg-config", "--modversion", "gstreamer-1.0"], text=True
    ).strip()
    if tuple(map(int, version.split(".")[:2])) < (1, 28):
        raise SystemExit("The pinned DTLS extension requires GStreamer 1.28 or newer")
    subprocess.run(["pkg-config", "--atleast-version=1.1.1", "openssl"], check=True)
    for name, digest in manifest["files"].items():
        if Path(name).name != name or Path(name).suffix not in (".c", ".h"):
            raise SystemExit("Invalid source manifest filename")
        path = cache / name
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
            continue
        if args.offline:
            raise SystemExit(f"Missing verified source: {name}")
        with urllib.request.urlopen(manifest["baseUrl"] + name, timeout=30) as response:
            data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
            raise SystemExit(f"Source checksum mismatch: {name}")
        path.write_bytes(data)
    with tempfile.TemporaryDirectory(prefix="build-", dir=output) as directory:
        build = Path(directory)
        for name in manifest["files"]:
            shutil.copyfile(cache / name, build / name)
        subprocess.run(
            ["patch", "--batch", "--fuzz=0", "-p1", "-i", str(source / "aead-srtp.patch")],
            cwd=build,
            check=True,
        )
        flags = shlex.split(subprocess.check_output(
            ["pkg-config", "--cflags", "--libs", "gstreamer-1.0", "openssl", "libcrypto"],
            text=True,
        ))
        library = build / "libgstdtls.so"
        subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")),
            "-shared", "-fPIC", "-O2", "-Werror=implicit-function-declaration",
            "-Wl,-z,relro,-z,now", '-DPACKAGE="crabfleet-dtls"',
            f'-DPACKAGE_VERSION="{manifest["version"]}"',
            '-DGST_PACKAGE_NAME="Crabfleet DTLS compatibility build"',
            '-DGST_PACKAGE_ORIGIN="https://gstreamer.freedesktop.org/"',
            *[str(build / name) for name in manifest["files"] if name.endswith(".c")],
            "-o", str(library), *flags,
        ], check=True)
        os.replace(library, output / library.name)
    print(f"Built {output / 'libgstdtls.so'} (system GStreamer {version})")


if __name__ == "__main__":
    main()
