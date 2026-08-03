import type {
    McpProjectConfig,
    MissionControlConfig,
    SessionDebugConfig,
} from '@mission-control/protocol';
import { McpProjectConfigSchema, MissionControlConfigSchema, SessionDebugConfigSchema } from '@mission-control/protocol';
import { stripJsoncComments } from '../../workflows/jsonc-parser';
import { readFile } from 'node:fs/promises';
import {
    detachSessionDebugConfig,
    parseSessionDebugConfigDocument,
    type SessionDebugConfigSourceMember,
} from './session-debug-config-document';

export type ReadUserResult = {
    readonly config: MissionControlConfig | undefined;
    readonly sessionDebugConfig: SessionDebugConfig;
    readonly sessionDebugSourceMembers: readonly SessionDebugConfigSourceMember[];
    readonly error?: string;
    readonly sessionDebugError?: string;
};
export type ReadProjectResult = { readonly config: McpProjectConfig | undefined; readonly error?: string };

export async function readUserConfig(userConfigPath: string): Promise<ReadUserResult> {
    const contents = await readConfigText(userConfigPath);
    if (contents === undefined) {
        return {
            config: undefined,
            sessionDebugConfig: SessionDebugConfigSchema.parse({}),
            sessionDebugSourceMembers: [],
        };
    }
    const sessionDebug = parseSessionDebugConfigDocument(contents);
    const textToParse = userConfigPath.endsWith('.jsonc') ? stripJsoncComments(contents) : contents;
    const parsed = parseJson(userConfigPath, textToParse);
    if (typeof parsed !== 'object') {
        return {
            config: undefined,
            sessionDebugConfig: sessionDebug.config,
            sessionDebugSourceMembers: sessionDebug.sourceMembers,
            ...(sessionDebug.error !== undefined ? { sessionDebugError: sessionDebug.error } : {}),
            error: parsed,
        };
    }
    const result = MissionControlConfigSchema.safeParse(detachSessionDebugConfig(parsed.value));
    return {
        config: result.success ? result.data : undefined,
        sessionDebugConfig: sessionDebug.config,
        sessionDebugSourceMembers: sessionDebug.sourceMembers,
        ...(sessionDebug.error !== undefined ? { sessionDebugError: sessionDebug.error } : {}),
        ...(!result.success ? { error: formatZodError(result.error) } : {}),
    };
}

export async function readProjectConfig(projectConfigPath: string): Promise<ReadProjectResult> {
    const contents = await readConfigText(projectConfigPath);
    if (contents === undefined) return { config: undefined };
    const parsed = parseJson(projectConfigPath, contents);
    if (typeof parsed !== 'object') return { config: undefined, error: parsed };
    const result = McpProjectConfigSchema.safeParse(parsed.value);
    return result.success ? { config: result.data } : { config: undefined, error: formatZodError(result.error) };
}

async function readConfigText(configPath: string): Promise<string | undefined> {
    try {
        const contents = await readFile(configPath, 'utf8');
        return contents.trim().length === 0 ? undefined : contents;
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
    }
}

function parseJson(source: string, contents: string): { readonly value: unknown } | string {
    try {
        return { value: JSON.parse(contents) };
    } catch (error: unknown) {
        const raw = error instanceof Error ? error.message : String(error);
        return `failed to parse JSON in ${source}: ${raw}`;
    }
}

function formatZodError(error: {
    readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string {
    const lines = error.issues.map((issue) => {
        const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
        return `  at ${path}: ${issue.message}`;
    });
    return `config validation failed:\n${lines.join('\n')}`;
}
