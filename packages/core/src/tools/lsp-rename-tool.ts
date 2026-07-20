/**
 * `lsp_rename` tool — effectful: renames a symbol across the workspace by
 * applying the `WorkspaceEdit` returned by `textDocument/rename`.
 *
 * This is a self-gating write-tier factory (mirrors `webfetch-tool-factory.ts` /
 * `ast-edit.ts`): it requests approval via `requestPermission` BEFORE applying
 * the edit, emits `file.diff.proposed` + `file.diff.applied` events through
 * `fileMutationDiffEvents`, and produces `DiffFile[]` in the output so the
 * session store records the mutation.
 *
 * The tool-definition shape is clean-room reimplemented from the
 * upstream agent harness lsp-core rename tool surface: same input fields
 * (filePath/line/character/newName) and same effectful contract (apply the
 * returned workspace edit), but fresh Zod schemas and mission-control's own
 * diff-event types.
 */
import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { DiffFileSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { fileMutationDiffEvents } from './file-mutation';
import type { LspClient, LspWorkspaceEdit } from './lsp-tool';
import { type ApplyWorkspaceEditDeps, applyLspWorkspaceEdit } from './lsp-workspace-edit';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import type { ToolRegistration } from './tool-registry-types';
import { ToolExecutionError } from './tool-registry-types';

const lspRenameInputSchema = z
    .object({
        uri: z.string().min(1),
        line: z.number().int().nonnegative(),
        character: z.number().int().nonnegative(),
        newName: z.string().min(1),
    })
    .strict();
export type LspRenameInput = z.infer<typeof lspRenameInputSchema>;

const lspRenameOutputSchema = z
    .object({
        kind: z.literal('lsp_rename'),
        status: z.enum(['applied', 'no_edit', 'not_renameable']),
        newName: z.string(),
        uri: z.string(),
        fileCount: z.number().int().nonnegative(),
        editCount: z.number().int().nonnegative(),
        diffFiles: z.array(DiffFileSchema),
    })
    .strict();
export type LspRenameOutput = z.infer<typeof lspRenameOutputSchema>;

export type LspRenameToolOptions = {
    readonly client: LspClient;
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly applyDeps?: ApplyWorkspaceEditDeps;
    readonly maxModelOutputChars?: number;
};

const DEFAULT_RENAME_OUTPUT_LIMIT = 8000;

export function createLspRenameToolRegistration(
    options: LspRenameToolOptions,
): ToolRegistration<LspRenameInput, LspRenameOutput> {
    const limit = options.maxModelOutputChars ?? DEFAULT_RENAME_OUTPUT_LIMIT;
    return {
        name: 'lsp_rename',
        description:
            'Rename a symbol across the workspace using the Language Server and apply the returned workspace edit. ' +
            'Requires approval; emits before/after diff events for every modified file.',
        capabilityClasses: ['write'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'File URI (e.g. file:///abs/path) containing the symbol.' },
                line: { type: 'integer', minimum: 0, description: '0-based line of the symbol.' },
                character: { type: 'integer', minimum: 0, description: '0-based character of the symbol.' },
                newName: { type: 'string', description: 'New symbol name.' },
            },
            required: ['uri', 'line', 'character', 'newName'],
            additionalProperties: false,
        },
        inputSchema: lspRenameInputSchema,
        outputSchema: lspRenameOutputSchema,
        outputLimit: { maxModelOutputChars: limit },
        execute: async (input, context) => executeRename(options, input, context.toolCallId),
        toEvents: (output, context) => renameDiffEvents(output, context.toolCallId),
    };
}

async function executeRename(
    options: LspRenameToolOptions,
    input: LspRenameInput,
    toolCallId: string,
): Promise<LspRenameOutput> {
    const client = options.client;

    const prepareRename = client.prepareRename;
    if (prepareRename !== undefined) {
        const preparable = await safeCall(() => prepareRename.call(client, input.uri, input.line, input.character));
        if (preparable === undefined) {
            return noEditResult(input, 'not_renameable');
        }
    }

    if (client.rename === undefined) {
        throw renameFailure('language client does not support rename');
    }
    const renameMethod = client.rename.bind(client);
    const edit = await safeCall(() => renameMethod(input.uri, input.line, input.character, input.newName));
    if (edit === undefined || !hasEdits(edit)) {
        return noEditResult(input, 'no_edit');
    }

    await requireApproval(options, toolCallId, input);

    const result = await applyLspWorkspaceEdit(edit, options.workspaceRoot, options.applyDeps);
    return {
        kind: 'lsp_rename',
        status: 'applied',
        newName: input.newName,
        uri: input.uri,
        fileCount: result.fileCount,
        editCount: result.editCount,
        diffFiles: result.applied.map((entry) => entry.diff),
    };
}

function hasEdits(edit: LspWorkspaceEdit): boolean {
    if (edit.documentChanges !== undefined && edit.documentChanges.length > 0) return true;
    if (edit.changes !== undefined && Object.keys(edit.changes).length > 0) return true;
    return false;
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn();
    } catch {
        return undefined;
    }
}

async function requireApproval(
    options: LspRenameToolOptions,
    toolCallId: string,
    input: LspRenameInput,
): Promise<void> {
    const request = permissionRequest({
        toolCallId,
        action: 'lsp_rename',
        reason: `rename symbol at ${input.uri}:${input.line}:${input.character} to "${input.newName}"`,
        permission: 'edit',
        patterns: [input.uri],
        workspaceRoot: options.workspaceRoot,
    });
    const decision = await requestToolPermission(options.requestPermission, request);
    if (decision.status === 'allow') return;
    throw renameFailure(decision.reason ?? `approval refused: ${decision.status}`);
}

function renameFailure(message: string): ToolExecutionError {
    return new ToolExecutionError({ code: 'tool_failed', message: `lsp_rename: ${message}`, retryable: false });
}

function noEditResult(input: LspRenameInput, status: 'no_edit' | 'not_renameable'): LspRenameOutput {
    return {
        kind: 'lsp_rename',
        status,
        newName: input.newName,
        uri: input.uri,
        fileCount: 0,
        editCount: 0,
        diffFiles: [],
    };
}

function renameDiffEvents(output: LspRenameOutput, toolCallId: string): readonly AgentEvent[] {
    if (output.diffFiles.length === 0) return [];
    return fileMutationDiffEvents(output.diffFiles, toolCallId, {
        proposed: 'lsp_rename proposed',
        applied: 'lsp_rename applied',
    });
}
