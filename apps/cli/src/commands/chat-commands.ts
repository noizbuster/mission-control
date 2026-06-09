import { defaultModelProviderSelection } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';
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
          readonly kind: 'model-status';
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

type CommandParts = {
    readonly head: string;
    readonly tail: string;
};

export type ChatLineOptions = {
    readonly modelChoices?: readonly ModelChoice[];
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
        default:
            return { kind: 'unknown-slash', command: parts.head };
    }
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

function splitCommandParts(input: string): CommandParts {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { head: '', tail: '' };
    }
    const firstWhitespace = trimmed.search(/\s/);
    if (firstWhitespace < 0) {
        return { head: trimmed, tail: '' };
    }
    return {
        head: trimmed.slice(0, firstWhitespace),
        tail: trimmed.slice(firstWhitespace + 1).trim(),
    };
}

function assertNever(value: never): never {
    throw new Error(`Unexpected model command result: ${String(value)}`);
}
