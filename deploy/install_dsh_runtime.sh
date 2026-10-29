#!/bin/sh
# Isolated Linux x64 runtime; never replaces the host's Node or starts services.
set -eu
test "$(uname -s)/$(uname -m)" = Linux/x86_64
runtime=/opt/zhixing-next/runtimes/dsh-0.2.2-alpha.2
node_version=24.21.0
archive=node-v${node_version}-linux-x64.tar.xz
checksum=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
mkdir -p "$runtime"
cd "$runtime"
if ! test -x "node-v${node_version}-linux-x64/bin/node"; then
  curl -fLsS "https://nodejs.org/dist/v${node_version}/${archive}" -o "$archive"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
  tar -xf "$archive"
fi
export PATH="$runtime/node-v${node_version}-linux-x64/bin:$runtime/node_modules/.bin:$PATH"
test "$(node --version)" = v24.21.0
if ! test -f package.json; then
  printf '%s\n' '{"private":true,"dependencies":{"@deepseek-ai/dsh":"0.2.2-alpha.2","pnpm":"11.28.5"}}' > package.json
fi
if test -f package-lock.json; then npm ci --omit=dev; else npm install --omit=dev; fi
# npm 11 blocks lifecycle scripts by default. These pinned installed packages
# are needed by the official host (PTY setup and provider SDK dependencies).
npm install-scripts approve node-pty protobufjs @google/genai @deepseek-ai/dsh-subprocess-local koffi
npm rebuild node-pty protobufjs @google/genai @deepseek-ai/dsh-subprocess-local koffi
node --version
pnpm --version
dsh --version
