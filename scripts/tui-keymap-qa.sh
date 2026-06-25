#!/usr/bin/env bash
# =============================================================================
# TUI keymap QA harness (T18 deliverable b).
#
# Drives DETERMINISTIC paths against the built `mctrl` CLI inside a tmux
# session, asserting observable output via `tmux capture-pane`. It launches the
# opentui TUI (native FFI, Node 26.3+ `--experimental-ffi`) against the offline
# `local/local-echo` provider so no network or credentials are required.
#
# DETERMINISTIC (asserted, must pass):
#   1. Launch gate  - the chat banner + prompt render.
#   2. Prompt submit - typing text + Enter renders the echo response.
#   3. /hotkeys      - the registry-driven keybind table renders (T17).
#   4. /help         - the commands + keyboard-shortcuts section renders.
#   5. /exit         - the chat UI disappears (clean exit).
#
# ENCODING-LIMITED (documented + SKIPPED, NOT asserted):
#   Alt/Ctrl chords (Alt+X palette, Ctrl+Alt+K which-key, Ctrl+P, <leader>...)
#   do NOT deliver reliably through `tmux send-keys` at the terminal/FFI
#   encoding boundary. This is the known gap noted across T8/T9/T13/T14/T16:
#   the keymap dispatch LOGIC is proven by `host.press` unit tests against a
#   real keymap (`createTestKeymap`); live terminal chord delivery is the
#   unit-only seam. The harness documents each below and does NOT fake a
#   chord-delivery assertion (per the task MUST NOT).
#
# Usage:
#   scripts/tui-keymap-qa.sh                # run all deterministic paths
#   MCTRL_BIN=node scripts/tui-keymap-qa.sh # override launcher (debug)
#   KEEP_SESSION=1 scripts/tui-keymap-qa.sh # leave the tmux session alive
#
# Exit status: 0 iff every deterministic path asserts; non-zero otherwise.
# =============================================================================
set -u

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIST="$REPO_ROOT/apps/cli/dist/index.js"
SESSION="mctrl-qa-$$"
DATA_DIR="$(mktemp -d -t mctrl-qa-XXXXXXXX)"
LOG_FILE="${MCTRL_QA_LOG:-$REPO_ROOT/.omo/evidence/task-18-tui-keymap-port.log}"
PANE_W=110
PANE_H=44
SETTLE_TRIES=15           # capture-pane retry attempts for an assertion
SETTLE_SLEEP=0.4          # seconds between retries
KEEP_SESSION="${KEEP_SESSION:-0}"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log() { printf '[qa] %s\n' "$*"; }
fail() { printf '[qa][FAIL] %s\n' "$*" >&2; }

mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"

# assert_pane_contains <description> <needle> [extra-needle...]
# Retries capture-pane up to SETTLE_TRIES, succeeds when ALL needles appear.
assert_pane_contains() {
    local desc="$1"; shift
    local -a needles=("$@")
    local attempt pane
    for attempt in $(seq 1 "$SETTLE_TRIES"); do
        pane="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)"
        printf '%s' "$pane" >> "$LOG_FILE"
        local missing=0 needle
        for needle in "${needles[@]}"; do
            if ! printf '%s' "$pane" | grep -qF -- "$needle"; then
                missing=1
            fi
        done
        if [ "$missing" -eq 0 ]; then
            log "PASS: $desc (try $attempt)"
            return 0
        fi
        sleep "$SETTLE_SLEEP"
    done
    fail "$desc — needles not found after $SETTLE_TRIES tries: ${needles[*]}"
    printf '\n--- last pane for [%s] ---\n%s\n' "$desc" "$pane" >&2
    return 1
}

# assert_pane_absent <description> <needle>
# Succeeds when the needle is GONE from the pane (used for the /exit gate).
assert_pane_absent() {
    local desc="$1"; shift
    local needle="$1"
    local attempt pane
    for attempt in $(seq 1 "$SETTLE_TRIES"); do
        pane="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)"
        printf '%s' "$pane" >> "$LOG_FILE"
        if ! printf '%s' "$pane" | grep -qF -- "$needle"; then
            log "PASS: $desc (try $attempt)"
            return 0
        fi
        sleep "$SETTLE_SLEEP"
    done
    fail "$desc — needle still present after $SETTLE_TRIES tries: $needle"
    return 1
}

cleanup() {
    local code=$?
    if [ "$KEEP_SESSION" -eq 1 ]; then
        log "KEEP_SESSION=1 — leaving tmux session '$SESSION' and data dir '$DATA_DIR'"
    else
        tmux kill-session -t "$SESSION" 2>/dev/null || true
        rm -rf "$DATA_DIR"
    fi
    exit "$code"
}
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------------------
# Pre-flight
# ----------------------------------------------------------------------------
if ! command -v tmux >/dev/null 2>&1; then
    fail "tmux not found on PATH"; exit 2
fi
if ! command -v node >/dev/null 2>&1; then
    fail "node not found on PATH"; exit 2
fi
if [ ! -f "$CLI_DIST" ]; then
    fail "built CLI dist not found at $CLI_DIST (run: pnpm --filter @mission-control/cli build)"
    exit 2
fi

REQUIRED_NODE_MAJOR=26
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
    fail "Node ${REQUIRED_NODE_MAJOR}+ required for --experimental-ffi (got v$(node -v))"
    exit 2
fi

# ----------------------------------------------------------------------------
# Launch the TUI
# ----------------------------------------------------------------------------
log "launching mctrl TUI in tmux session '$SESSION' (local/local-echo, data=$DATA_DIR)"
tmux new-session -d -s "$SESSION" -x "$PANE_W" -y "$PANE_H" \
    "env MCTRL_DATA_DIR='$DATA_DIR' node --experimental-ffi '$CLI_DIST' --provider local --model local-echo; sleep 20"

# 1. Launch gate
if ! assert_pane_contains "launch gate renders chat banner" "mission-control chat"; then
    fail "TUI failed to launch"
    exit 1
fi

# 2. Prompt submit (printable delivery + Enter + echo response)
UNIQUE_PROMPT="qa-echo-token-$$"
tmux send-keys -t "$SESSION" "$UNIQUE_PROMPT" Enter
if ! assert_pane_contains "prompt submit renders echo response" "$UNIQUE_PROMPT" "received prompt"; then
    exit 1
fi

# 3. /hotkeys — registry-driven keybind table (T17)
tmux send-keys -t "$SESSION" "/hotkeys" Enter
# Registry output: Ctrl+P (model cycle) + Ctrl+C (documented twice-to-exit) +
# a namespace-grouped chord. Ctrl+C appears in /hotkeys banner text here.
if ! assert_pane_contains "/hotkeys renders registry keybind table" "Ctrl+P" "Ctrl+E"; then
    exit 1
fi

# 4. /help — commands list + keyboard-shortcuts section
tmux send-keys -t "$SESSION" "/help" Enter
if ! assert_pane_contains "/help renders commands list" "/exit" "/hotkeys"; then
    exit 1
fi

# 5. /exit — chat UI disappears (clean exit)
tmux send-keys -t "$SESSION" "/exit" Enter
if ! assert_pane_absent "/exit dismisses chat banner" "mission-control chat"; then
    exit 1
fi

# ----------------------------------------------------------------------------
# Encoding-gap documentation (NOT asserted — would be dishonest to fake it)
# ----------------------------------------------------------------------------
log "================================================================"
log "ENCODING-LIMITED PATHS (documented SKIPPED, not asserted):"
log "  - Alt+X     (command.palette.show)   — Alt-chord not delivered via tmux send-keys"
log "  - Ctrl+Alt+K (which-key.toggle)       — Ctrl+Alt chord not delivered"
log "  - Ctrl+Alt+Shift+K (which-key layout) — same encoding gap"
log "  - Ctrl+P    (model.cycle)             — Ctrl chord delivery unreliable in tmux"
log "  - <leader>m / <leader>1..9            — two-key sequence needs pending-seq delivery"
log "  - Ctrl+W/K/U + Ctrl+Y (kill-ring)     — Ctrl chords + ring state"
log "  - Ctrl+G (abg overlay)                — Ctrl chord"
log "These are covered by the unit-test seam (createRecordingTextarea +"
log "createTestKeymap host.press) in apps/cli/src/platform/keymap/*.test.ts."
log "Race/timing invariants (double-Esc, IME-defer, double-Enter, Ctrl+C"
log "double-enqueue) are unit-only by nature — see the race-index in"
log ".omo/evidence/tui-keymap-port-parity-matrix.md section 17."
log "================================================================"

log "ALL DETERMINISTIC PATHS PASSED"
log "log: $LOG_FILE"
exit 0
