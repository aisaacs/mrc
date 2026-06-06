#!/usr/bin/env bash
#
# install.sh — Install Mr. Claude (mrc)
# Usage: curl -fsSL https://aisaacs.github.io/mrc/install.sh | bash
#
set -euo pipefail

REPO="aisaacs/mrc"
PREFIX="${MRC_PREFIX:-$HOME/.local}"
BIN_DIR="${PREFIX}/bin"
SHARE_DIR="${PREFIX}/share/mrc"

# --- Detect platform ---
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

echo "  Installing mrc for ${os}-${arch}..."

# --- Determine latest version ---
VERSION="${MRC_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  if [ -z "$VERSION" ]; then
    echo "Failed to determine latest version." >&2
    exit 1
  fi
fi
echo "  Version: ${VERSION}"

# --- Download and extract ---
TARBALL="mrc-${VERSION}-${os}-${arch}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "  Downloading ${TARBALL}..."
curl -fsSL -o "${TMPDIR}/${TARBALL}" "$URL"

echo "  Installing to ${PREFIX}/..."
mkdir -p "$BIN_DIR" "$SHARE_DIR"
tar -xzf "${TMPDIR}/${TARBALL}" -C "$PREFIX"
chmod +x "${BIN_DIR}/mrc"

# --- Verify ---
if [ ! -x "${BIN_DIR}/mrc" ]; then
  echo "Installation failed — binary not found at ${BIN_DIR}/mrc" >&2
  exit 1
fi

echo ""
echo "  ✓ mrc installed to ${BIN_DIR}/mrc"
echo "  ✓ Docker context at ${SHARE_DIR}/"

# --- PATH check ---
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo ""
  echo "  ⚠ ${BIN_DIR} is not in your PATH. Add it:"
  echo ""
  SHELL_NAME=$(basename "${SHELL:-/bin/bash}")
  case "$SHELL_NAME" in
    zsh)  echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
    fish) echo "    fish_add_path ~/.local/bin" ;;
    *)    echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
  esac
fi

echo ""
echo "  May the Schwartz be with you!"
echo ""
echo "  Next steps:"
echo "    export MRC_SESSION_NAMING_ANTHROPIC_API_KEY=\"sk-ant-...\"  # host-only, for session naming; or ~/.config/mrc/.env"
echo "    mrc ~/your/repo"
echo ""
