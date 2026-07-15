import type { AbgGraphSpec } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';

export function shouldRunInteractiveChat(
    args: CliArgs,
    graph: AbgGraphSpec | undefined,
    hasInjectedChatInput: boolean,
): boolean {
    return (
        graph === undefined &&
        args.mode === 'tui' &&
        (hasInjectedChatInput || (process.stdin.isTTY === true && process.stdout.isTTY === true))
    );
}
