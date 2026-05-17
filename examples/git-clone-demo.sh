#!/usr/bin/env bash
# examples/git-clone-demo.sh
#
# The demo that proves v0.0.3 works:
#   1. Alice creates an Opengit repo, pushes some commits via stock `git push`.
#   2. A mirror replicates it.
#   3. Alice's storage is taken offline.
#   4. Bob runs `git clone opengit://<key>` and gets the repo from the mirror.
#
# Requires: bash, git, node>=20, npm, this monorepo installed.
#
# This is a SCRIPT not a test — it exercises real network paths via the DHT
# and may be slow on first run. CI runs the unit tests in test/ instead.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_DIR="$(mktemp -d -t opengit-clone-demo.XXXXXX)"
cleanup () {
  echo "(demo) cleaning up $DEMO_DIR"
  rm -rf "$DEMO_DIR"
}
trap cleanup EXIT

ALICE_HOME="$DEMO_DIR/alice-home"
MIRROR_HOME="$DEMO_DIR/mirror-home"
BOB_HOME="$DEMO_DIR/bob-home"

mkdir -p "$ALICE_HOME" "$MIRROR_HOME" "$BOB_HOME"

CLI="node $ROOT/packages/opengit-cli/bin/opengit.js"
MIRROR="node $ROOT/packages/opengit-mirror/bin/opengit-mirror.js"
HELPER="$ROOT/packages/git-remote-opengit/bin/git-remote-opengit.js"

# Make `git` find our helper. git looks for git-remote-<scheme> in PATH.
HELPER_BIN_DIR="$DEMO_DIR/bin"
mkdir -p "$HELPER_BIN_DIR"
ln -sf "$HELPER" "$HELPER_BIN_DIR/git-remote-opengit"
export PATH="$HELPER_BIN_DIR:$PATH"

echo "(demo) ── 1. alice creates a repo ──"
ALICE_OUT="$(OPENGIT_HOME="$ALICE_HOME" $CLI init demo-clone)"
echo "$ALICE_OUT"
KEY_LINE="$(echo "$ALICE_OUT" | grep '^key:')"
KEY="${KEY_LINE##*opengit://}"
echo "(demo) repo key: $KEY"

echo "(demo) ── 2. alice prepares a real git repo and pushes to opengit ──"
WORK="$DEMO_DIR/alice-work"
mkdir -p "$WORK"
cd "$WORK"
git init --quiet -b main .
git config user.email alice@example
git config user.name alice
echo 'hello opengit' > README.md
git add README.md
git commit --quiet -m 'initial'

# (push will only work when v0.0.3 helper push path is exercised against
# an alive serve.)
OPENGIT_HOME="$ALICE_HOME" $CLI serve demo-clone &
SERVE_PID=$!
sleep 2
echo "(demo) alice serving as PID $SERVE_PID"

# git push opengit://<key>/...
set +e
OPENGIT_HOME="$ALICE_HOME" git push "opengit://$KEY" main
PUSH_STATUS=$?
set -e
if [ $PUSH_STATUS -ne 0 ]; then
  echo "(demo) NOTE: push exited $PUSH_STATUS. v0.0.3 push round-trip is best-effort;"
  echo "(demo) the receive side should still have stored the pack — continuing."
fi

echo "(demo) ── 3. mirror starts and replicates ──"
OPENGIT_HOME="$MIRROR_HOME" $MIRROR --repo "$KEY" &
MIRROR_PID=$!
sleep 4
echo "(demo) mirror as PID $MIRROR_PID"

echo "(demo) ── 4. alice goes offline ──"
kill $SERVE_PID || true
wait $SERVE_PID 2>/dev/null || true
echo "(demo) alice offline"

sleep 2

echo "(demo) ── 5. bob clones from the mirror ──"
cd "$DEMO_DIR"
set +e
OPENGIT_HOME="$BOB_HOME" git clone "opengit://$KEY" bob-clone
CLONE_STATUS=$?
set -e

echo "(demo) ── shutdown ──"
kill $MIRROR_PID || true
wait $MIRROR_PID 2>/dev/null || true

if [ $CLONE_STATUS -eq 0 ] && [ -f "$DEMO_DIR/bob-clone/README.md" ]; then
  echo "(demo) ✓ end-to-end clone via mirror succeeded"
  exit 0
fi

echo "(demo) ⚠ clone did not complete cleanly (exit $CLONE_STATUS)."
echo "(demo) Inspect $DEMO_DIR for state. v0.0.3 push/clone is best-effort against"
echo "(demo) the live DHT; results vary with network conditions and bootstrap reachability."
exit 1
