#!/usr/bin/env bash
# Rebuilds the checked-in Windows trampoline launchers from source.
#
# Usage:
#   native/build-trampolines.sh <llvm-mingw-bin-dir>
#
# The toolchain is llvm-mingw (https://github.com/mstorsjo/llvm-mingw),
# pinned to the release below so local artifacts and CI rebuilds are
# byte-identical: lld writes deterministic PE files, no debug paths are
# embedded, and the CRT is linked statically. After rebuilding, verify
# with:
#
#   sha256sum -c native/checksums.txt
#
# from the repository root.

set -euo pipefail

LLVM_MINGW_RELEASE="20260812"
ARCHES=(
  "x64:x86_64-w64-windows-gnu"
  "arm64:aarch64-w64-windows-gnu"
)

BIN_DIR="${1:?usage: build-trampolines.sh <llvm-mingw bin dir>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CC="${BIN_DIR%/}/clang"

if [[ ! -x "${CC}" ]]; then
  echo "error: clang not found at ${CC}" >&2
  echo "download llvm-mingw ${LLVM_MINGW_RELEASE}:" >&2
  echo "  https://github.com/mstorsjo/llvm-mingw/releases/tag/${LLVM_MINGW_RELEASE}" >&2
  exit 1
fi

for entry in "${ARCHES[@]}"; do
  arch="${entry%%:*}"
  triple="${entry#*:}"
  out="${ROOT}/native/bin/win32/${arch}/type-a-bin-trampoline.exe"
  mkdir -p "$(dirname "${out}")"
  echo "building ${out}"
  # -Os: small launcher; -static: no CRT DLL dependency; -s: no symbols
  # (also keeps host paths out of the image for reproducible builds).
  # --no-insert-timestamp zeroes the PE TimeDateStamp for identical rebuilds.
  "${CC}" --target="${triple}" -Os -static -s -municode -Wall -Wextra -Werror \
    -Wl,--no-insert-timestamp -o "${out}" "${ROOT}/native/trampoline.c" \
    -lshell32
done

echo "done; verify against the recorded checksums with:"
echo "  (cd ${ROOT} && sha256sum -c native/checksums.txt)"
