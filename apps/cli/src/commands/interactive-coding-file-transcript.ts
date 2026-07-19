import { redactCredentialText } from '@mission-control/core';
import { type AgentEvent, type DiffFile, DiffFileSchema } from '@mission-control/protocol';
import type { TranscriptPart } from '@mission-control/tui/state';
import {
    type BoundedFileWriteBody,
    boundFileWriteDisplayBody,
    FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES,
} from './interactive-coding-file-write-preview';

const DiffFilesSchema = DiffFileSchema.array();

export type FileResultProjectionInput = {
    readonly toolBaseId: string;
    readonly toolCallId: string;
    readonly structuredOutput: unknown;
    readonly events: readonly AgentEvent[];
};

export function projectFileResultParts(input: FileResultProjectionInput): readonly TranscriptPart[] {
    const { toolBaseId, toolCallId, structuredOutput, events } = input;
    const appliedFiles = events.flatMap((event) => (event.type === 'file.diff.applied' ? (event.diffFiles ?? []) : []));
    const proposedFiles = events.flatMap((event) =>
        event.type === 'file.diff.proposed' ? (event.diffFiles ?? []) : [],
    );
    const files =
        appliedFiles.length > 0
            ? appliedFiles
            : proposedFiles.length > 0
              ? proposedFiles
              : parseStructuredDiffFiles(structuredOutput);
    return files.map((file, index) => ({
        id: `${toolBaseId}:result:${index}`,
        type: 'diff',
        toolCallId,
        text: renderDiffFile(file),
        filePath: redact(file.filePath),
        status: appliedFiles.length > 0 || proposedFiles.length === 0 ? 'completed' : 'pending',
    }));
}

function parseStructuredDiffFiles(value: unknown): readonly DiffFile[] {
    if (!isRecord(value)) return [];
    const parsed = DiffFilesSchema.safeParse(value['diffFiles']);
    return parsed.success ? parsed.data : [];
}

function renderDiffFile(file: DiffFile): string {
    const body = retainDiffBody(file);
    if (!body.truncated) return body.text;
    const placeholder = `Diff body: ${FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES}/${body.originalBytes} bytes (truncated)`;
    const framed = boundFileWriteDisplayBody(`${placeholder}\n${body.text}`);
    const retainedBody = framed.text.slice(placeholder.length + 1);
    const returnedBytes = Buffer.byteLength(retainedBody, 'utf8');
    return `Diff body: ${returnedBytes}/${body.originalBytes} bytes (truncated)\n${retainedBody}`;
}

function retainDiffBody(file: DiffFile): BoundedFileWriteBody {
    const chunks: string[] = [];
    let originalBytes = 0;
    let returnedBytes = 0;
    let firstLine = true;
    for (const line of renderedDiffLines(file)) {
        const separator = firstLine ? '' : '\n';
        firstLine = false;
        const separatorBytes = separator.length;
        const lineBytes = Buffer.byteLength(line, 'utf8');
        originalBytes += separatorBytes + lineBytes;
        if (returnedBytes >= FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES) continue;
        const boundedLine = boundFileWriteDisplayBody(line, lineBytes);
        const remainingBytes = FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES - returnedBytes;
        if (separatorBytes + boundedLine.returnedBytes <= remainingBytes) {
            chunks.push(`${separator}${boundedLine.text}`);
            returnedBytes += separatorBytes + boundedLine.returnedBytes;
            continue;
        }
        if (separator !== '') chunks.push(separator);
        returnedBytes += separatorBytes;
        for (const character of boundedLine.text) {
            const characterBytes = Buffer.byteLength(character, 'utf8');
            if (returnedBytes + characterBytes > FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES) break;
            chunks.push(character);
            returnedBytes += characterBytes;
        }
    }
    return { text: chunks.join(''), originalBytes, returnedBytes, truncated: returnedBytes < originalBytes };
}

function* renderedDiffLines(file: DiffFile): Generator<string> {
    const oldPath = file.oldFilePath ?? file.filePath;
    yield file.changeKind === 'added' ? '--- /dev/null' : `--- a/${redact(oldPath)}`;
    yield file.changeKind === 'deleted' ? '+++ /dev/null' : `+++ b/${redact(file.filePath)}`;
    for (const hunk of file.hunks) {
        yield `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        for (const line of hunk.lines) {
            yield `${linePrefix(line.kind)}${redact(line.content)}`;
        }
    }
}

function linePrefix(kind: 'context' | 'added' | 'removed'): string {
    if (kind === 'added') return '+';
    if (kind === 'removed') return '-';
    return ' ';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redact(text: string): string {
    return redactCredentialText(text, []);
}
