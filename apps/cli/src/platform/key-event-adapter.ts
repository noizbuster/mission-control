/**
 * opentui `KeyEvent` -> Ink `{ input, key }` adapter.
 *
 * opentui's `useKeyboard` delivers one `KeyEvent` per physical keypress.
 * The chat bridge's `handleInput(core, input, key)` was written for Ink's
 * `useInput`, which assembles a `{ input: string, key: Key }` pair per
 * keypress. This adapter reproduces Ink's exact assembly rules so the ~30
 * `handleInput` call sites keep working unchanged.
 *
 * Translation rules are lifted verbatim from Ink 7's `useInput` + `parseKeypress`
 * (node_modules/ink/build/hooks/use-input.js):
 *   - `key.*` boolean flags derive from `name` (`up` -> `upArrow`, etc.).
 *   - `input` for `ctrl+<letter>` is the letter (so `handleInput`'s
 *     `input === 'c'` Ctrl+C check still fires); Ink does NOT deliver the raw
 *     control character here.
 *   - `input` is `sequence` otherwise, but forced to `''` for non-alphanumeric
 *     key names (arrows, tab, backspace, delete, pageup/down, home, end, f-keys).
 *   - a leading ESC (`\x1b`) is stripped (matters for the lone Escape key).
 *
 * Per-event, no buffering: `handleInput` already handles single-char input
 * correctly (its `input.includes('\r')` / `input.split(/[\r\n]/)` / per-char
 * printable-insert paths all work one keypress at a time), and per-event
 * delivery preserves live typing echo. Ink's "batched multi-char" delivery was
 * an artifact of stdin chunking that opentui's per-event model decomposes
 * naturally; `handleInput` is correct under both.
 */

/** Structural subset of opentui's `KeyEvent` that this adapter reads. */
export interface OpenTuiKeyInput {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly sequence?: string;
    readonly super?: boolean;
    readonly hyper?: boolean;
    readonly capsLock?: boolean;
    readonly numLock?: boolean;
}

/**
 * Ink's `Key` boolean surface, structurally mirrored so existing bridge code
 * and tests (`makeKey(): InkKeyShape`) keep compiling after dropping the
 * Ink `Key` type dependency. Fields the bridge never reads
 * (`super`/`hyper`/`capsLock`/`numLock`) are retained to match Ink's full `Key`
 * shape and keep test fixtures intact.
 */
export interface InkKeyShape {
    readonly upArrow: boolean;
    readonly downArrow: boolean;
    readonly leftArrow: boolean;
    readonly rightArrow: boolean;
    readonly pageUp: boolean;
    readonly pageDown: boolean;
    readonly home: boolean;
    readonly end: boolean;
    readonly return: boolean;
    readonly escape: boolean;
    readonly ctrl: boolean;
    readonly shift: boolean;
    readonly tab: boolean;
    readonly backspace: boolean;
    readonly delete: boolean;
    readonly meta: boolean;
    readonly super: boolean;
    readonly hyper: boolean;
    readonly capsLock: boolean;
    readonly numLock: boolean;
}

/** The `{ input, key }` pair the bridge's `handleInput` consumes. */
export interface AdaptedInput {
    readonly input: string;
    readonly key: InkKeyShape;
}

/**
 * Ink `nonAlphanumericKeys` set (from parse-keypress.js): names whose `input`
 * Ink forces to `''`. Built from `Object.values(keyName)` plus `'backspace'`.
 * Notably EXCLUDES `return`, `escape`, and `space` (those carry real text).
 */
const NON_ALPHANUMERIC_KEY_NAMES: ReadonlySet<string> = new Set<string>([
    'up',
    'down',
    'left',
    'right',
    'clear',
    'end',
    'home',
    'insert',
    'delete',
    'pageup',
    'pagedown',
    'f1',
    'f2',
    'f3',
    'f4',
    'f5',
    'f6',
    'f7',
    'f8',
    'f9',
    'f10',
    'f11',
    'f12',
    'tab',
    'backspace',
]);

const ESCAPE = '\u001b';

/**
 * Reproduce Ink's `input` derivation for a single keypress.
 * See module docstring for the rule precedence.
 */
function deriveInput(name: string, ctrl: boolean, sequence: string | undefined): string {
    let input: string;
    if (ctrl) {
        // Ink: `input = keypress.name ?? ''` for ctrl-held keypresses. For
        // ctrl+letter this is the letter ('c', 'g', ...); for ctrl+arrow it is
        // the word ('up'), suppressed to '' below by NON_ALPHANUMERIC.
        input = name;
    } else {
        input = sequence ?? '';
    }
    if (NON_ALPHANUMERIC_KEY_NAMES.has(name)) {
        input = '';
    }
    if (input.startsWith(ESCAPE)) {
        input = input.slice(1);
    }
    return input;
}

function buildKey(key: OpenTuiKeyInput): InkKeyShape {
    const name = key.name;
    return {
        upArrow: name === 'up',
        downArrow: name === 'down',
        leftArrow: name === 'left',
        rightArrow: name === 'right',
        pageUp: name === 'pageup',
        pageDown: name === 'pagedown',
        home: name === 'home',
        end: name === 'end',
        return: name === 'return',
        escape: name === 'escape',
        ctrl: key.ctrl === true,
        shift: key.shift === true,
        tab: name === 'tab',
        backspace: name === 'backspace',
        delete: name === 'delete',
        meta: key.meta === true,
        super: key.super === true,
        hyper: key.hyper === true,
        capsLock: key.capsLock === true,
        numLock: key.numLock === true,
    };
}

/**
 * Adapt a single opentui `KeyEvent` into Ink's `{ input, key }` shape.
 * Stateless and synchronous; call once per `useKeyboard` event.
 */
export function adaptKeyEvent(key: OpenTuiKeyInput): AdaptedInput {
    const input = deriveInput(key.name, key.ctrl === true, key.sequence);
    return { input, key: buildKey(key) };
}

/**
 * Factory returning a `{ consume }` translator. Named to match the bridge's
 * `useKeyboard` wiring; `consume` is a thin wrapper around {@link adaptKeyEvent}
 * (no buffering is needed because `handleInput` handles per-event input).
 */
export function createKeyEventAdapter(): {
    readonly consume: (key: OpenTuiKeyInput) => AdaptedInput;
} {
    return {
        consume: (key: OpenTuiKeyInput): AdaptedInput => adaptKeyEvent(key),
    };
}
