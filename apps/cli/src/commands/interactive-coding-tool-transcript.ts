import { redactCredentialText } from '@mission-control/core';
import type { ToolCall } from '@mission-control/protocol';
import type {
    CommandTranscriptPart,
    InlineToolTranscriptPart,
    SubagentTranscriptPart,
    TranscriptPart,
    TranscriptPartStatus,
} from '@mission-control/tui/state';

export type ToolSettlementTranscriptInput = {
    readonly toolBaseId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: 'completed' | 'failed';
    readonly modelOutput?: string;
    readonly modelOutputTruncated?: boolean;
    readonly structuredOutput?: unknown;
    readonly errorMessage?: string;
    readonly messageId?: string;
};

type CommandMetadata = {
    readonly command?: string;
    readonly cwd?: string;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly timedOut?: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly stdoutTruncated?: boolean;
    readonly stderrTruncated?: boolean;
    readonly stdoutOriginalBytes?: number;
    readonly stderrOriginalBytes?: number;
    readonly stdoutReturnedBytes?: number;
    readonly stderrReturnedBytes?: number;
    readonly status?: 'completed' | 'failed';
};

type RichCommandTranscriptPart = CommandTranscriptPart & {
    readonly toolCallId: string;
    readonly cwd?: string;
    readonly timedOut?: boolean;
    readonly stdoutTruncated?: boolean;
    readonly stderrTruncated?: boolean;
};

type RichSubagentTranscriptPart = SubagentTranscriptPart & {
    readonly toolCallId: string;
};

export function pendingToolTranscriptPart(
    toolCall: ToolCall,
    text: string,
    toolBaseId: string,
    messageId?: string,
): InlineToolTranscriptPart {
    return {
        id: toolBaseId,
        type: 'inline-tool',
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        text: redact(text),
        status: 'pending',
        ...(messageId ? { messageId } : {}),
    };
}

export function projectToolSettlementPart(input: ToolSettlementTranscriptInput): TranscriptPart {
    if (input.toolName === 'command.run' || input.toolName === 'bash.run') {
        return projectCommandPart(input);
    }
    if (input.toolName === 'task') {
        return projectSubagentPart(input);
    }

    const output = input.modelOutput === undefined ? undefined : redact(input.modelOutput);
    const error = input.status === 'failed' ? redact(input.errorMessage ?? 'unknown error') : undefined;
    const appliedFiles = readAppliedFiles(input.structuredOutput);
    const type = isFileTool(input.toolName) ? 'block-tool' : 'inline-tool';
    return {
        id: input.toolBaseId,
        type,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        text: output ?? error ?? input.toolName,
        status: input.status,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(appliedFiles !== undefined ? { appliedFiles } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
    };
}

function projectCommandPart(input: ToolSettlementTranscriptInput): RichCommandTranscriptPart {
    const metadata = parseCommandMetadata(input.structuredOutput);
    const detail = commandDetail(input, metadata);
    const error = input.status === 'failed' ? redact(input.errorMessage ?? 'unknown error') : undefined;
    const command = metadata.command;
    const summaryMetadata = [
        metadata.cwd === undefined ? undefined : `cwd: ${metadata.cwd}`,
        metadata.timedOut === true ? 'timed out' : undefined,
        metadata.stdoutTruncated === true || metadata.stderrTruncated === true ? 'output truncated' : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    const commandText = command ?? input.toolName;
    const text = summaryMetadata.length > 0 ? `${commandText} (${summaryMetadata.join(', ')})` : commandText;
    return {
        id: input.toolBaseId,
        type: 'command',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        text,
        status: input.status,
        ...(command !== undefined ? { command } : {}),
        ...(detail.length > 0 ? { detail } : {}),
        ...(metadata.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
        ...(metadata.cwd !== undefined ? { cwd: metadata.cwd } : {}),
        ...(metadata.timedOut !== undefined ? { timedOut: metadata.timedOut } : {}),
        ...(metadata.stdoutTruncated !== undefined ? { stdoutTruncated: metadata.stdoutTruncated } : {}),
        ...(metadata.stderrTruncated !== undefined ? { stderrTruncated: metadata.stderrTruncated } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
    };
}

function projectSubagentPart(input: ToolSettlementTranscriptInput): RichSubagentTranscriptPart {
    const metadata = parseSubagentMetadata(input.structuredOutput);
    const text = redact(metadata.output ?? input.modelOutput ?? input.errorMessage ?? input.toolName);
    const error = input.status === 'failed' ? redact(input.errorMessage ?? 'unknown error') : undefined;
    return {
        id: input.toolBaseId,
        type: 'subagent',
        toolCallId: input.toolCallId,
        text,
        status: input.status === 'failed' ? input.status : (metadata.status ?? input.status),
        ...(metadata.agentName !== undefined ? { agentName: metadata.agentName } : {}),
        ...(metadata.sessionId !== undefined ? { sessionId: metadata.sessionId } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
    };
}

function commandDetail(input: ToolSettlementTranscriptInput, metadata: CommandMetadata): string {
    if (input.modelOutput !== undefined && input.modelOutputTruncated !== true) {
        return redact(input.modelOutput);
    }
    if (metadata.command === undefined || metadata.status === undefined) {
        return input.modelOutput === undefined ? '' : redact(input.modelOutput);
    }
    const exit = metadata.exitCode ?? metadata.signal ?? 'unknown';
    const stdout = metadata.stdout !== undefined && metadata.stdout.length > 0 ? `\nstdout:\n${metadata.stdout}` : '';
    const stderr = metadata.stderr !== undefined && metadata.stderr.length > 0 ? `\nstderr:\n${metadata.stderr}` : '';
    const truncation =
        metadata.stdoutTruncated === true || metadata.stderrTruncated === true
            ? `\n[truncated stdout=${metadata.stdoutReturnedBytes ?? 0}/${metadata.stdoutOriginalBytes ?? 0} stderr=${metadata.stderrReturnedBytes ?? 0}/${metadata.stderrOriginalBytes ?? 0}]`
            : '';
    return redact(`$ ${metadata.command}\nstatus: ${metadata.status} exit: ${exit}${stdout}${stderr}${truncation}`);
}

function parseCommandMetadata(value: unknown): CommandMetadata {
    if (!isRecord(value) || value['kind'] !== 'command_run') return {};
    const rawCommand = value['command'];
    const command =
        Array.isArray(rawCommand) && rawCommand.every((entry) => typeof entry === 'string')
            ? redact(rawCommand.join(' '))
            : undefined;
    const status = value['status'] === 'completed' || value['status'] === 'failed' ? value['status'] : undefined;
    const cwd = readString(value, 'cwd');
    const exitCode = readNumber(value, 'exitCode');
    const signal = readString(value, 'signal');
    const timedOut = readBoolean(value, 'timedOut');
    const stdout = readString(value, 'stdout', true);
    const stderr = readString(value, 'stderr', true);
    const stdoutTruncated = readBoolean(value, 'stdoutTruncated');
    const stderrTruncated = readBoolean(value, 'stderrTruncated');
    const stdoutOriginalBytes = readNumber(value, 'stdoutOriginalBytes');
    const stderrOriginalBytes = readNumber(value, 'stderrOriginalBytes');
    const stdoutReturnedBytes = readNumber(value, 'stdoutReturnedBytes');
    const stderrReturnedBytes = readNumber(value, 'stderrReturnedBytes');
    return {
        ...(command !== undefined ? { command } : {}),
        ...(cwd !== undefined ? { cwd: redact(cwd) } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal: redact(signal) } : {}),
        ...(timedOut !== undefined ? { timedOut } : {}),
        ...(stdout !== undefined ? { stdout: redact(stdout) } : {}),
        ...(stderr !== undefined ? { stderr: redact(stderr) } : {}),
        ...(stdoutTruncated !== undefined ? { stdoutTruncated } : {}),
        ...(stderrTruncated !== undefined ? { stderrTruncated } : {}),
        ...(stdoutOriginalBytes !== undefined ? { stdoutOriginalBytes } : {}),
        ...(stderrOriginalBytes !== undefined ? { stderrOriginalBytes } : {}),
        ...(stdoutReturnedBytes !== undefined ? { stdoutReturnedBytes } : {}),
        ...(stderrReturnedBytes !== undefined ? { stderrReturnedBytes } : {}),
        ...(status !== undefined ? { status } : {}),
    };
}

function parseSubagentMetadata(value: unknown): {
    readonly agentName?: string;
    readonly sessionId?: string;
    readonly status?: TranscriptPartStatus;
    readonly output?: string;
} {
    if (!isRecord(value)) return {};
    const sessionId = readString(value, 'sessionId');
    const agentName = readString(value, 'agentName') ?? readString(value, 'agent');
    const status = value['status'] === 'running' ? 'background' : normalizeStatus(value['status']);
    const output = readTaskOutput(value);
    return {
        ...(agentName !== undefined ? { agentName: redact(agentName) } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(output !== undefined ? { output } : {}),
    };
}

function readTaskOutput(value: Readonly<Record<string, unknown>>): string | undefined {
    const output = readString(value, 'output');
    if (output !== undefined) return output;
    const batch = value['batch'];
    if (!Array.isArray(batch)) return undefined;
    const outputs = batch.flatMap((entry) =>
        isRecord(entry) && typeof entry['output'] === 'string' ? [entry['output']] : [],
    );
    return outputs.length > 0 ? outputs.join('\n') : undefined;
}

function readAppliedFiles(value: unknown): readonly string[] | undefined {
    if (!isRecord(value)) return undefined;
    const rawFiles = value['appliedFiles'];
    if (!Array.isArray(rawFiles) || !rawFiles.every((entry) => typeof entry === 'string')) return undefined;
    return rawFiles.map(redact);
}

function normalizeStatus(value: unknown): TranscriptPartStatus | undefined {
    return value === 'completed' || value === 'failed' ? value : undefined;
}

function readNumber(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
    const entry = value[key];
    return typeof entry === 'number' ? entry : undefined;
}

function readBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
    const entry = value[key];
    return typeof entry === 'boolean' ? entry : undefined;
}

function readString(value: Readonly<Record<string, unknown>>, key: string, allowEmpty = false): string | undefined {
    const entry = value[key];
    return typeof entry === 'string' && (allowEmpty || entry.length > 0) ? entry : undefined;
}

function isFileTool(toolName: string): boolean {
    return toolName === 'file.patch' || toolName === 'file.edit' || toolName === 'file.write';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redact(text: string): string {
    return redactCredentialText(text, []);
}
