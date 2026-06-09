export type EmptyChatInput = {
    readonly type: 'empty';
};

export type PromptChatInput = {
    readonly type: 'prompt';
    readonly prompt: string;
};

export type SlashChatCommand = {
    readonly type: 'slash';
    readonly commandID: string;
    readonly argumentsText: string;
};

export type SkillChatCommand = {
    readonly type: 'skill';
    readonly skillID: string;
    readonly argumentsText: string;
};

export type InvalidChatInput = {
    readonly type: 'invalid';
    readonly message: string;
};

export type ParsedChatInput = EmptyChatInput | PromptChatInput | SlashChatCommand | SkillChatCommand | InvalidChatInput;

export type ChatCommandInput = SlashChatCommand | SkillChatCommand;

type CommandParts = {
    readonly head: string;
    readonly tail: string;
};

const skillIDPattern = /^[A-Za-z0-9_.:/-]+$/;

export function parseChatInput(input: string): ParsedChatInput {
    const line = input.trim();
    if (line.length === 0) {
        return { type: 'empty' };
    }
    if (line.startsWith('/')) {
        return parseSlashInput(line.slice(1));
    }
    if (line.startsWith('$')) {
        return parseSkillInput(line.slice(1));
    }
    return {
        type: 'prompt',
        prompt: line,
    };
}

function parseSlashInput(input: string): ParsedChatInput {
    const parts = splitCommandParts(input);
    if (parts.head.length === 0) {
        return {
            type: 'invalid',
            message: 'Slash command is empty',
        };
    }
    return {
        type: 'slash',
        commandID: parts.head,
        argumentsText: parts.tail,
    };
}

function parseSkillInput(input: string): ParsedChatInput {
    const parts = splitCommandParts(input);
    if (parts.head.length === 0) {
        return {
            type: 'invalid',
            message: 'Skill command is empty',
        };
    }
    if (!skillIDPattern.test(parts.head)) {
        return {
            type: 'invalid',
            message: 'Invalid skill command',
        };
    }
    return {
        type: 'skill',
        skillID: parts.head,
        argumentsText: parts.tail,
    };
}

function splitCommandParts(input: string): CommandParts {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return {
            head: '',
            tail: '',
        };
    }
    const firstWhitespace = trimmed.search(/\s/);
    if (firstWhitespace < 0) {
        return {
            head: trimmed,
            tail: '',
        };
    }
    return {
        head: trimmed.slice(0, firstWhitespace),
        tail: trimmed.slice(firstWhitespace + 1).trim(),
    };
}
