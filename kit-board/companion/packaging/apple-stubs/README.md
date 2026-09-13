# Apple link stubs for cross-compiled test builds

Text-based stubs (TBD v4) for two macOS system libraries that the Rust standard
library links on Apple targets (`-liconv`, which re-exports `libcharset`) and that
zig's bundled Darwin libc does not ship. They let `scripts/cross-macos-from-windows.sh`
link a **test** build of `observatory` on a Windows host without the Apple SDK.
Both libraries exist on every macOS installation, so the produced binary resolves
them at load time.

They are never used by the release pipeline: cargo-dist builds each Apple target on a
native macOS runner with Apple's toolchain and the platform TLS verifier.
