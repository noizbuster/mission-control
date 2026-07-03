import { type SidecarStreamFrame, validateSidecarStreamFrames } from '@mission-control/protocol';
import { redactCredentialText } from '../providers/credential-resolver.js';
import { truncateToValidUtf8Boundary } from '../providers/stream-decoder.js';

/**
 * Cumulative output cap mirrored from the Rust `pty.alloc` handler. Applied on
 * the TypeScript side as belt-and-suspenders so a flooding pty process cannot
 * stream unbounded data to the model even if the sidecar cap is bypassed.
 */
export const PTY_OUTPUT_CAP_BYTES = 64 * 1024;

export interface PtyAllocRequest {
    readonly sessionId: string;
    readonly command?: string;
    readonly cwd?: string;
    readonly cols?: number;
    readonly rows?: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
}

/**
 * Transport seam that delivers a `pty.alloc` request to the sidecar v3
 * capability and returns the emitted `SidecarStreamFrame`s (seq strictly
 * increasing, final frame carries end:true). The real adapter writes a
 * `stream_open` (kind `pty`) line and collects `stream_frame` lines until the
 * terminal end frame; tests inject an in-memory mock.
 */
export interface PtySessionTransport {
    allocPty(request: PtyAllocRequest): Promise<readonly SidecarStreamFrame[]>;
}

export type PtySendStreamOpen = (request: PtyAllocRequest) => Promise<readonly SidecarStreamFrame[]>;

export interface PtyAssembledOutput {
    readonly output: string;
    readonly truncated: boolean;
    readonly originalBytes: number;
    readonly returnedBytes: number;
    readonly streamError: string | null;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly ended: boolean;
}

export interface AssemblePtyFramesOptions {
    readonly maxBytes?: number;
    readonly redactionSecrets?: readonly string[];
    readonly skipValidation?: boolean;
}

export function createPtySessionTransport(send: PtySendStreamOpen): PtySessionTransport {
    return {
        allocPty: (request) => send(request),
    };
}

/**
 * Assembles a `SidecarStreamFrame` stream emitted by a `pty.alloc` allocation
 * into a single capped, redacted output. Enforces:
 *
 * - monotonic seq + single terminal end frame (via `validateSidecarStreamFrames`)
 * - cumulative byte cap (`maxBytes`, default 64KB): stops accepting payload once
 *   the cap is reached and signals truncation
 * - secret redaction over the accepted payload
 * - typed streamError / exitCode / timedOut derivation from the terminal frame
 */
export function assemblePtyFrames(
    frames: readonly SidecarStreamFrame[],
    options: AssemblePtyFramesOptions = {},
): PtyAssembledOutput {
    const maxBytes = options.maxBytes ?? PTY_OUTPUT_CAP_BYTES;
    const validated = options.skipValidation === true ? frames : validateSidecarStreamFrames(frames);

    let payload = '';
    let originalBytes = 0;
    let accepting = true;
    let streamError: string | null = null;
    let ended = false;

    for (const frame of validated) {
        if (frame.payload.length > 0) {
            originalBytes += Buffer.byteLength(frame.payload, 'utf8');
            if (accepting) {
                const budget = maxBytes - Buffer.byteLength(payload, 'utf8');
                if (budget > 0) {
                    payload = `${payload}${takeUtf8Prefix(frame.payload, budget)}`;
                }
                if (Buffer.byteLength(payload, 'utf8') >= maxBytes) {
                    accepting = false;
                }
            }
        }
        if (frame.end) {
            ended = true;
        }
        if (frame.error !== undefined && streamError === null) {
            streamError = frame.error;
        }
    }

    const capped = !accepting;
    const redacted = redactCredentialText(payload, options.redactionSecrets ?? []);
    const timedOut = streamError === 'timed_out';
    const exitCode = parseExitCode(streamError);
    const truncated = capped || streamError === 'output_truncated';

    return {
        output: redacted,
        truncated,
        originalBytes,
        returnedBytes: Buffer.byteLength(redacted, 'utf8'),
        streamError,
        exitCode,
        timedOut,
        ended,
    };
}

function parseExitCode(streamError: string | null): number | null {
    if (streamError === null) {
        return 0;
    }
    const match = /^nonzero_exit:(-?\d+)$/u.exec(streamError);
    if (match === null) {
        return null;
    }
    const parsed = Number.parseInt(match[1] ?? '', 10);
    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Returns the longest UTF-8-safe prefix of `text` whose byte length is at most
 * `maxBytes`. Backs off across continuation bytes so the result never splits a
 * multibyte character.
 */
function takeUtf8Prefix(text: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return '';
    }
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) {
        return text;
    }
    return truncateToValidUtf8Boundary(buf, maxBytes).toString('utf8');
}
