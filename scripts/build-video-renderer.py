#!/usr/bin/env python3
"""Build the pinned renderer into the hash-addressed build cache; no global installs."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "licenses/ketchup-video-renderer"
PINS = json.loads((ROOT / "scripts/video-assets.json").read_text())
INVENTORY = json.loads((SOURCE / "source-inventory.json").read_text())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(path, expected):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("Not a regular input: " + str(path))
    data = path.read_bytes()
    if digest(data) != expected:
        raise RuntimeError("Input digest mismatch: " + str(path))
    return data


def fetch(url, expected):
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    if digest(data) != expected:
        raise RuntimeError("Downloaded digest mismatch: " + url)
    return data


def extract(data, dest, source_only=False):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for item in archive:
            parts = PurePosixPath(item.name).parts[1:]
            if not parts or item.isdir():
                continue
            if source_only and item.issym() and Path(item.name).name == "README.md":
                continue  # Upstream documentation links are not compiler inputs.
            if not item.isfile() or any(p in ("..", ".", "") for p in parts):
                raise RuntimeError("Unsafe source archive member: " + item.name)
            rel = Path(*parts)
            if source_only and rel.suffix not in (".rs", ".toml", ".md", ".txt") and not rel.name.startswith(("LICENSE", "COPYING", "Cargo.lock", "wasm-binding.ts")):
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(item).read())
            target.chmod(0o755 if item.mode & 0o111 else 0o644)


def run(args, cwd, env):
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True, timeout=480)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True)
    args = parser.parse_args()
    cache = Path(args.cache).resolve()
    for pin in PINS["sourceFiles"]:
        verify(SOURCE / pin["path"], pin["sha256"])
    tools = INVENTORY["buildTools"]
    toolchain = os.environ.get("RUST_TOOLCHAIN_DIR")
    if not toolchain:
        try:
            rustc = subprocess.check_output(["rustup", "which", "--toolchain", "1.95.0", "rustc"], text=True).strip()
            toolchain = str(Path(rustc).resolve().parent.parent)
        except (OSError, subprocess.CalledProcessError) as error:
            raise RuntimeError("Existing pinned Rust 1.95.0 + wasm32 target required; set RUST_TOOLCHAIN_DIR (no automatic install)") from error
    toolchain = Path(toolchain).resolve()
    for name, expected in tools["executableHashes"].items():
        verify(toolchain / name, expected)
    canonical = Path(os.environ.get("CANONICAL_CARGO_HOME", Path.home() / ".cargo")).resolve()
    with tempfile.TemporaryDirectory(prefix="pstack-renderer-") as temp:
        work = Path(temp).resolve()
        if shutil.disk_usage(work).free < 2 * 1024**3:
            raise RuntimeError("Renderer build needs 2 GiB free temporary capacity")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CARGO_", "RUST", "OPENCLAW_"))}
        env.update(CARGO_HOME=str(work / "cargo-home"), CARGO_TARGET_DIR=str(work / "target"),
                   RUSTC=str(toolchain / "bin/rustc"), CARGO_BUILD_JOBS="3",
                   GIT_CEILING_DIRECTORIES=str(work) + os.pathsep + str(canonical))
        std = tools["officialDistribution"]["rust-std"]["fields"]
        std_bytes = fetch(std["xz_url"], std["xz_hash"])
        with tarfile.open(fileobj=io.BytesIO(std_bytes)) as archive:
            for item in archive:
                marker = "/lib/rustlib/wasm32-unknown-unknown/lib/"
                if marker in item.name and item.isfile():
                    installed = toolchain / "lib/rustlib/wasm32-unknown-unknown/lib" / Path(item.name).name
                    verify(installed, digest(archive.extractfile(item).read()))
        for name, pin in zip(("resvg-js", "resvg", "woff2"), INVENTORY["immutableArchives"]):
            extract(fetch(pin["url"], pin["sha256"]), work / "source" / name, source_only=True)
        run(["patch", "-d", work / "source/resvg-js", "-p1", "-i", SOURCE / "source.patch"], work, env)
        verify(work / "source/resvg-js/Cargo.toml", digest((SOURCE / "resvg-js.Cargo.toml").read_bytes()))
        verify(work / "source/resvg-js/wasm-binding.ts", digest((SOURCE / "candidate/wasm-binding.ts").read_bytes()))
        shutil.copyfile(SOURCE / "Cargo.lock", work / "source/resvg-js/Cargo.lock")
        registry = "index.crates.io-1949cf8c6b5b557f"
        crates = [p for p in INVENTORY["packages"] if (p["source"] or "").startswith("registry+")]
        archive_dir = work / "cargo-home/registry/cache" / registry
        archive_dir.mkdir(parents=True)
        for package in crates:
            name = package["name"] + "-" + package["version"] + ".crate"
            existing = canonical / "registry/cache" / registry / name
            data = verify(existing, package["archiveSha256"]) if existing.exists() else fetch(package["sourceUrl"], package["archiveSha256"])
            (archive_dir / name).write_bytes(data)
        run([toolchain / "bin/cargo", "fetch", "--locked", "--manifest-path", "source/resvg-js/Cargo.toml"], work, env)
        remaps = [str(work) + "=/pstack-video-build", str(canonical) + "=/cargo", str(toolchain) + "=/rust-toolchain"]
        for package in crates:
            name = package["name"] + "-" + package["version"]
            data = verify(archive_dir / (name + ".crate"), package["archiveSha256"])
            src = work / "cargo-home/registry/src" / registry / name
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                for item in archive:
                    if item.isfile():
                        rel = Path(*PurePosixPath(item.name).parts[1:])
                        verify(src / rel, digest(archive.extractfile(item).read()))
        env["RUSTFLAGS"] = " ".join("--remap-path-prefix=" + p for p in remaps)
        run([toolchain / "bin/cargo", "build", "--locked", "--offline", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", "source/resvg-js/Cargo.toml"], work, env)
        verify(work / "source/resvg-js/Cargo.lock", INVENTORY["rootLockSha256"])
        bindgen = os.environ.get("WASM_BINDGEN")
        if not bindgen:
            pin = tools["wasmBindgen"]["archive"]
            extract(fetch(pin["url"], pin["sha256"]), work / "bindgen")
            bindgen = work / "bindgen/wasm-bindgen"
        verify(Path(bindgen), tools["wasmBindgen"]["executableSha256"])
        run([bindgen, "target/wasm32-unknown-unknown/release/resvg_js.wasm", "--target", "web", "--out-dir", "candidate", "--out-name", "index"], work, env)
        shutil.copyfile(SOURCE / "candidate/wasm-binding.ts", work / "candidate/wasm-binding.ts")
        shutil.copyfile(SOURCE / "bundle-candidate.mjs", work / "bundle-candidate.mjs")
        env.pop("PSTACK_ARTIFACT_SOURCE", None)
        run(["node", "bundle-candidate.mjs"], work, env)
        for name, pin in PINS["renderer"].items():
            verify(work / "candidate" / name, pin["sha256"])
        wasm = PINS["renderer"]["index_bg.wasm"]
        cache.mkdir(parents=True, exist_ok=True)
        dest = cache / wasm["sha256"]
        try:
            with dest.open("xb") as output:
                output.write((work / "candidate/index_bg.wasm").read_bytes())
        except FileExistsError:
            verify(dest, wasm["sha256"])
        print(json.dumps({"renderer": wasm["sha256"], "lockedPackages": len(INVENTORY["packages"]), "sourceBuilt": True}))


if __name__ == "__main__":
    main()
