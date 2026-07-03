/**
 * Inline source for the persistent Python kernel subprocess, run via
 * `spawn('python3', ['-I', '-B', '-c', EVAL_PYTHON_RUNNER_SOURCE])`. Speaks a
 * synchronous JSON Lines protocol over stdin/stdout: the host writes
 * `{type:'run'|'close'|'tool-reply'}` lines to stdin; the runner writes
 * `{type:'ready'|'result'|'tool-call'}` lines to stdout. User `print()` output
 * is captured per-cell and returned inside the `result` payload, so the wire is
 * reserved for protocol + tool re-entry. Code executes in a single persistent
 * namespace (`_NS`), so top-level declarations survive across cells. The prelude
 * exposes `read`/`grep`/`search`/`find`/`ls`/`glob` proxies that block on a
 * stdin readline while the host services the tool call.
 */
export const EVAL_PYTHON_RUNNER_SOURCE = `
import sys, json, io, traceback

REAL_OUT = sys.stdout
REAL_IN = sys.stdin
_NS = {"__name__": "__eval__"}

def _emit(obj):
    REAL_OUT.write(json.dumps(obj) + "\\n")
    REAL_OUT.flush()

def _tool_call(name, args):
    _emit({"type": "tool-call", "name": name, "args": args})
    line = REAL_IN.readline()
    if not line:
        raise RuntimeError("eval bridge closed")
    try:
        msg = json.loads(line)
    except Exception as exc:
        raise RuntimeError("eval bridge malformed reply: " + str(exc))
    payload = msg.get("reply", msg) if isinstance(msg, dict) else msg
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError(payload.get("error", "tool call failed") if isinstance(payload, dict) else "tool call failed")
    return payload.get("value")

def _install_prelude():
    _NS["_tool_call"] = _tool_call
    _NS["read"] = lambda path: _tool_call("read", {"path": path})
    _NS["grep"] = lambda pattern, path=None: _tool_call("grep", {"pattern": pattern, "path": path})
    _NS["search"] = lambda pattern, path=None: _tool_call("search", {"pattern": pattern, "path": path})
    _NS["find"] = lambda pattern="**/*": _tool_call("find", {"pattern": pattern})
    _NS["ls"] = lambda path=".": _tool_call("ls", {"path": path})
    _NS["glob"] = lambda pattern: _tool_call("glob", {"pattern": pattern})

def _run(code):
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        compiled = compile(code, "<eval-cell>", "exec")
        exec(compiled, _NS)
    except Exception:
        tb = traceback.format_exc()
        sys.stdout = old
        _emit({"type": "result", "ok": False, "output": buf.getvalue(), "error": tb})
        return
    sys.stdout = old
    _emit({"type": "result", "ok": True, "output": buf.getvalue()})

_install_prelude()
_emit({"type": "ready"})
while True:
    line = REAL_IN.readline()
    if not line:
        break
    try:
        msg = json.loads(line)
    except Exception:
        continue
    t = msg.get("type")
    if t == "run":
        _run(msg.get("code", ""))
    elif t == "reset":
        _NS.clear()
        _NS["__name__"] = "__eval__"
        _install_prelude()
        _emit({"type": "result", "ok": True, "output": ""})
    elif t == "close":
        break
sys.exit(0)
`;
