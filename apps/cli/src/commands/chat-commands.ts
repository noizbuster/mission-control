import { defaultModelProviderSelection } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ApprovalLevel } from './approval-level.js';
import { isApprovalLevel } from './approval-level.js';
import { splitCommandParts } from './chat-command-parts.js';
import { parseSessionSlashCommand } from './chat-session-commands.js';
import { formatModelSelection, type ModelChoice, resolveModelCommand } from './interactive-chat-model.js';

export type ChatLineAction =
    | {
          readonly kind: 'empty';
      }
    | {
          readonly kind: 'prompt';
          readonly prompt: string;
      }
    | {
          readonly kind: 'bash';
          readonly command: string;
      }
    | {
          readonly kind: 'bash-display-only';
          readonly command: string;
      }
    | {
          readonly kind: 'queue';
          readonly prompt: string;
      }
    | {
          readonly kind: 'steer';
          readonly prompt: string;
      }
    | {
          readonly kind: 'resume';
      }
    | {
          readonly kind: 'new-session';
          readonly sessionId?: string;
      }
    | {
          readonly kind: 'clear';
          readonly sessionId?: string;
      }
    | {
          readonly kind: 'session';
          readonly sessionId?: string;
      }
    | {
          readonly kind: 'sessions';
      }
    | {
          readonly kind: 'tree';
          readonly sessionId?: string;
      }
    | {
          readonly kind: 'branch';
          readonly mode: 'continue' | 'select';
          readonly entryId: string;
          readonly prompt?: string;
      }
    | {
          readonly kind: 'fork';
          readonly entryId: string;
          readonly sessionId?: string;
      }
    | {
          readonly kind: 'clone';
          readonly sessionId?: string;
      }
    | {
          readonly kind: 'compact';
          readonly instructions?: string;
      }
    | {
          readonly kind: 'export';
          readonly path: string;
      }
    | {
          readonly kind: 'rename';
          readonly name?: string;
      }
    | {
          readonly kind: 'undo';
      }
    | {
          readonly kind: 'redo';
      }
    | {
          readonly kind: 'help';
      }
    | {
          readonly kind: 'hotkeys';
      }
    | {
          readonly kind: 'interrupt';
      }
    | {
          readonly kind: 'exit';
      }
    | {
          readonly kind: 'model-pick';
      }
    | {
          readonly kind: 'model-list';
          readonly visibleChoices: readonly ModelChoice[];
          readonly totalCount: number;
      }
    | {
          readonly kind: 'model';
          readonly selection: ModelProviderSelection;
      }
    | {
          readonly kind: 'trust';
          readonly action: TrustCommandAction;
      }
    | {
          readonly kind: 'approval';
          readonly level?: ApprovalLevel;
      }
    | {
          readonly kind: 'skill';
          readonly name: string;
          readonly instruction: string;
      }
    | {
          readonly kind: 'unknown-slash';
          readonly command: string;
      }
    | {
          readonly kind: 'invalid';
          readonly message: string;
      };

export type SkillInvocationAction = Extract<ChatLineAction, { readonly kind: 'skill' }>;

export type TrustCommandAction = 'trust' | 'status' | 'deny' | 'reset';

export type ChatLineOptions = {
    readonly modelChoices?: readonly ModelChoice[];
    /**
     * Discovered skill names for `/<skill-name>` slash expansion (todo 10).
     * Reserved slash commands and session-navigation commands always take
     * precedence over a skill name; a name is only matched here in the default
     * branch after those checks. When omitted, `/<name>` falls through to the
     * unknown-slash path (skill loading via `$skill` still works).
     */
    readonly knownSkillNames?: ReadonlySet<string>;
    /**
     * Active session id, used to resolve a default export path for `/export` when no
     * explicit path is supplied. Omitted when the chat has no durable session.
     */
    readonly currentSessionId?: string;
};

export function parseChatLine(value: string, options: ChatLineOptions = {}): ChatLineAction {
    const line = value.trim();
    if (line.length === 0) {
        return { kind: 'empty' };
    }
    if (line.startsWith('/')) {
        return parseSlashCommand(line, options);
    }
    if (line.startsWith('$')) {
        return parseSkillInvocation(line);
    }
    if (line.startsWith('!!')) {
        return parseBashInvocation(line.slice(2), 'bash-display-only');
    }
    if (line.startsWith('!')) {
        return parseBashInvocation(line.slice(1), 'bash');
    }
    return { kind: 'prompt', prompt: line };
}

export function formatModelProviderSelection(selection: ModelProviderSelection): string {
    return formatModelSelection(selection);
}

export function formatSkillInvocationPrompt(action: SkillInvocationAction): string {
    if (action.instruction.length === 0) {
        return `Invoke skill "${action.name}".`;
    }
    return `Invoke skill "${action.name}": ${action.instruction}`;
}

function parseSlashCommand(line: string, options: ChatLineOptions): ChatLineAction {
    const parts = splitCommandParts(line.slice(1));
    if (parts.head.length === 0) {
        return { kind: 'invalid', message: 'Slash command is empty' };
    }
    switch (parts.head) {
        case 'model':
            return parseModelCommand(parts.tail, options);
        case 'queue':
            return parsePromptCommand('queue', parts.tail);
        case 'steer':
            return parsePromptCommand('steer', parts.tail);
        case 'resume':
            return parseNoArgumentCommand('resume', parts.tail);
        case 'interrupt':
            return parseNoArgumentCommand('interrupt', parts.tail);
        case 'exit':
            return parseNoArgumentCommand('exit', parts.tail);
        case 'trust':
            return parseTrustCommand(parts.tail);
        case 'approval':
            return parseApprovalCommand(parts.tail);
        case 'compact':
            return parseCompactCommand(parts.tail);
        case 'export':
            return parseExportCommand(parts.tail, options);
        case 'rename':
            return parseRenameCommand(parts.tail);
        case 'undo':
            return parseNoArgumentCommand('undo', parts.tail);
        case 'redo':
            return parseNoArgumentCommand('redo', parts.tail);
        case 'help':
            return parseNoArgumentCommand('help', parts.tail);
        case 'hotkeys':
            return parseNoArgumentCommand('hotkeys', parts.tail);
        default:
            return resolveUnreservedSlash(parts, options);
    }
}

function resolveUnreservedSlash(
    parts: { readonly head: string; readonly tail: string },
    options: ChatLineOptions,
): ChatLineAction {
    const sessionAction = parseSessionSlashCommand(parts.head, parts.tail);
    if (sessionAction !== undefined) {
        return sessionAction;
    }
    if (options.knownSkillNames?.has(parts.head)) {
        return { kind: 'skill', name: parts.head, instruction: parts.tail };
    }
    return { kind: 'unknown-slash', command: parts.head };
}

function parsePromptCommand(kind: 'queue' | 'steer', prompt: string): ChatLineAction {
    if (prompt.length === 0) {
        return { kind: 'invalid', message: `/${kind} requires prompt text` };
    }
    return { kind, prompt };
}

function parseBashInvocation(commandText: string, kind: 'bash' | 'bash-display-only'): ChatLineAction {
    const command = commandText.trim();
    if (command.length === 0) {
        return { kind: 'invalid', message: 'Bash command is empty' };
    }
    return { kind, command };
}

function parseNoArgumentCommand(
    kind: 'resume' | 'sessions' | 'interrupt' | 'exit' | 'undo' | 'redo' | 'help' | 'hotkeys',
    input: string,
): ChatLineAction {
    if (input.length > 0) {
        return { kind: 'invalid', message: `/${kind} does not accept arguments` };
    }
    return { kind };
}

function parseCompactCommand(input: string): ChatLineAction {
    if (input.length === 0) {
        return { kind: 'compact' };
    }
    return { kind: 'compact', instructions: input };
}

function parseExportCommand(input: string, options: ChatLineOptions): ChatLineAction {
    const parts = splitCommandParts(input);
    if (parts.tail.length > 0) {
        return { kind: 'invalid', message: '/export accepts at most one file path' };
    }
    if (parts.head.length > 0) {
        return { kind: 'export', path: parts.head };
    }
    if (options.currentSessionId !== undefined) {
        return { kind: 'export', path: `session-${options.currentSessionId}.html` };
    }
    return { kind: 'invalid', message: '/export requires a file path or an active session' };
}

function parseRenameCommand(input: string): ChatLineAction {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { kind: 'rename' };
    }
    return { kind: 'rename', name: trimmed };
}

function parseTrustCommand(input: string): ChatLineAction {
    const parts = splitCommandParts(input);
    if (parts.head.length === 0) {
        return { kind: 'trust', action: 'trust' };
    }
    if (parts.tail.length > 0) {
        return invalidTrustCommand();
    }
    switch (parts.head) {
        case 'status':
        case 'deny':
        case 'reset':
            return { kind: 'trust', action: parts.head };
        default:
            return invalidTrustCommand();
    }
}

function invalidTrustCommand(): ChatLineAction {
    return {
        kind: 'invalid',
        message: '/trust supports: status, deny, reset',
    };
}

function parseApprovalCommand(input: string): ChatLineAction {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { kind: 'approval' };
    }
    if (isApprovalLevel(trimmed)) {
        return { kind: 'approval', level: trimmed };
    }
    return {
        kind: 'invalid',
        message: '/approval supports: verbose, safe, aggressive, reckless, yolo',
    };
}

function parseModelCommand(input: string, options: ChatLineOptions): ChatLineAction {
    const result = resolveModelCommand(input, defaultModelProviderSelection, {
        ...(options.modelChoices !== undefined ? { choices: options.modelChoices } : {}),
    });
    switch (result.type) {
        case 'pick':
            return { kind: 'model-pick' };
        case 'select':
            return { kind: 'model', selection: result.selection };
        case 'list':
            return { kind: 'model-list', visibleChoices: result.visibleChoices, totalCount: result.totalCount };
        case 'invalid':
            return { kind: 'invalid', message: result.message };
        default:
            return assertNever(result);
    }
}

function parseSkillInvocation(line: string): ChatLineAction {
    const parts = splitCommandParts(line.slice(1));
    if (parts.head.length === 0) {
        return { kind: 'invalid', message: 'Skill command is empty' };
    }
    if (!/^[A-Za-z0-9_.:/-]+$/.test(parts.head)) {
        return { kind: 'invalid', message: 'Invalid skill command' };
    }
    return {
        kind: 'skill',
        name: parts.head,
        instruction: parts.tail,
    };
}

function assertNever(value: never): never {
    throw new Error(`Unexpected model command result: ${String(value)}`);
}
