#!/usr/bin/env bash
# Cross-compile a macOS TEST build of `observatory` from a Windows host (Git Bash).
#
#   scripts/cross-macos-from-windows.sh [aarch64|x86_64] [output-dir]
#
# What it does and why:
#   * zig (from the `ziglang` PyPI wheel) is the C compiler and Mach-O linker; no Apple SDK.
#   * cargo-zigbuild's generated wrappers translate rustc's Apple linker arguments, but its
#     host probe fails on Windows, so this script drives plain `cargo build` with the wrappers.
#   * The build uses `--no-default-features`: TLS trusts the bundled Mozilla roots instead of
#     the macOS Keychain (the `platform-tls` feature needs Apple's Security framework to link).
#     `observatory doctor` reports `"tls_roots": "webpki"` for such a build.
#   * `packaging/apple-stubs/` supplies `libiconv`/`libcharset` text stubs the Rust standard
#     library asks for on Apple targets.
#   * `--remap-path-prefix` keeps the local user name and checkout path out of the binary.
#
# Prerequisites (one time):
#   python -m pip install --user "ziglang==0.14.1"
#   cargo install --locked cargo-zigbuild
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#   cargo zigbuild --release --target aarch64-apple-darwin -p observatory --no-default-features
#     (this fails at the probe on Windows but writes the wrappers this script needs)
#
# The release pipeline never uses this: cargo-dist builds Apple targets on native macOS runners.
set -euo pipefail

arch="${1:-aarch64}"
out="${2:-target/macos-test}"
case "$arch" in
  aarch64) target="aarch64-apple-darwin"; upper="AARCH64_APPLE_DARWIN"; lower="aarch64_apple_darwin" ;;
  x86_64) target="x86_64-apple-darwin"; upper="X86_64_APPLE_DARWIN"; lower="x86_64_apple_darwin" ;;
  *) echo "usage: $0 [aarch64|x86_64] [output-dir]" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")/.." && pwd)"
zigdir="$(python -c 'import ziglang, os; print(os.path.dirname(ziglang.__file__))')"
export PATH="$(cygpath "$zigdir"):$PATH"
export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-$here/target/zig-cache}"
export ZIG_LOCAL_CACHE_DIR="${ZIG_LOCAL_CACHE_DIR:-$here/target/zig-cache-local}"
mkdir -p "$ZIG_GLOBAL_CACHE_DIR" "$ZIG_LOCAL_CACHE_DIR"

wrappers="$(ls -d "$LOCALAPPDATA"/cargo-zigbuild/*/wrappers/* 2>/dev/null | head -1 || true)"
if [ -z "$wrappers" ]; then
  echo "no cargo-zigbuild wrappers found; run the cargo zigbuild command from the header once" >&2
  exit 1
fi
cc="$(ls "$wrappers"/zigcc-"$target"-*.bat | head -1)"
cxx="$(ls "$wrappers"/zigcxx-"$target"-*.bat | head -1)"
w="$(cygpath -w "$wrappers")"
stubs="$(cygpath -w "$here/packaging/apple-stubs")"

export "CARGO_TARGET_${upper}_LINKER=$(cygpath -w "$cc")"
export "CC_${lower}=$(cygpath -w "$cc")"
export "CXX_${lower}=$(cygpath -w "$cxx")"
export "AR_${lower}=$w\\ar.exe"
export "RANLIB_${lower}=$w\\zigranlib.bat"
# Keep this machine's user name and checkout path out of the binary's panic locations.
home_w="$(cygpath -w "$HOME")"
here_w="$(cygpath -w "$here")"
export "CARGO_TARGET_${upper}_RUSTFLAGS=-L native=$stubs --remap-path-prefix=$here_w=companion --remap-path-prefix=$home_w=home"

cargo build --release --target "$target" -p observatory --no-default-features
mkdir -p "$out"
cp "target/$target/release/observatory" "$out/observatory-$target"
chmod 755 "$out/observatory-$target"
echo "wrote $out/observatory-$target (test build: bundled TLS roots, unsigned)"
