#!/usr/bin/env sh
set -eu

MISSION_CONTROL_REPO="${MISSION_CONTROL_REPO:-noizbuster/mission-control}"
os="${MISSION_CONTROL_TEST_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
arch="${MISSION_CONTROL_TEST_ARCH:-$(uname -m)}"

case "$os" in
  linux) os="linux" ;;
  darwin) os="darwin" ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64|amd64|x64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

artifact="mctrl-${os}-${arch}.tar.gz"
url="https://github.com/${MISSION_CONTROL_REPO}/releases/latest/download/${artifact}"
install_dir="${HOME}/.local/bin"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

echo "downloading ${url}"
curl -fsSL "$url" -o "${tmp_dir}/${artifact}"
tar -xzf "${tmp_dir}/${artifact}" -C "$tmp_dir"
mkdir -p "$install_dir"

if [ -f "${tmp_dir}/mctrl" ]; then
  cp "${tmp_dir}/mctrl" "${install_dir}/mctrl"
elif [ -f "${tmp_dir}/bin/mctrl" ]; then
  cp "${tmp_dir}/bin/mctrl" "${install_dir}/mctrl"
else
  echo "artifact did not contain mctrl" >&2
  exit 1
fi

chmod +x "${install_dir}/mctrl"
if [ -f "${tmp_dir}/mission-control-sidecar" ]; then
  cp "${tmp_dir}/mission-control-sidecar" "${install_dir}/mission-control-sidecar"
elif [ -f "${tmp_dir}/bin/mission-control-sidecar" ]; then
  cp "${tmp_dir}/bin/mission-control-sidecar" "${install_dir}/mission-control-sidecar"
else
  echo "artifact did not contain mission-control-sidecar" >&2
  exit 1
fi

chmod +x "${install_dir}/mission-control-sidecar"
echo "installed mctrl to ${install_dir}/mctrl"
echo "installed mission-control-sidecar to ${install_dir}/mission-control-sidecar"
echo "ensure ${install_dir} is on PATH"
echo "run: mctrl --version"
