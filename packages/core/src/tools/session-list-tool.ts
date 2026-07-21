import { SessionAwaitingDetailsSchema } from '@mission-control/protocol';
import { z } from 'zod';
import {
    listSessionIds,
    normalizeSessionId,
    readSessionProjection,
    type SessionSummary,
    type SessionToolsOptions,
    summarizeProjection,
} from './session-tools-shared';
import type { ToolRegistration } from './tool-registry-types';

const OUTPUT_LIMIT_CHARS = 6000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const sessionListInputSchema = z.object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    from_date: z.string().optional().describe('Filter sessions from this date (ISO 8601).'),
    to_date: z.string().optional().describe('Filter sessions until this date (ISO 8601).'),
});

export type SessionListInput = z.infer<typeof sessionListInputSchema>;

export const sessionListParametersJsonSchema = {
    type: 'object',
    properties: {
        limit: { type: 'integer', description: `Maximum sessions to return (default ${DEFAULT_LIMIT}).` },
        from_date: { type: 'string', description: 'Filter sessions from this date (ISO 8601).' },
        to_date: { type: 'string', description: 'Filter sessions until this date (ISO 8601).' },
    },
    additionalProperties: false,
} as const;

export const sessionListOutputSchema = z.object({
    sessions: z.array(
        z.object({
            sessionId: z.string(),
            status: z.string(),
            awaiting: SessionAwaitingDetailsSchema.optional(),
            eventCount: z.number(),
            messageCount: z.number(),
            createdAt: z.string().optional(),
            updatedAt: z.string().optional(),
            cwd: z.string().optional(),
            sessionName: z.string().optional(),
            parentSessionId: z.string().optional(),
            title: z.string().optional(),
            category: z.string().optional(),
            agentName: z.string().optional(),
            agentsUsed: z.array(z.string()),
            corrupt: z.boolean(),
        }),
    ),
    truncated: z.boolean(),
});

export type SessionListOutput = z.infer<typeof sessionListOutputSchema>;

export function formatSessionListModelOutput(output: SessionListOutput): string {
    if (output.sessions.length === 0) {
        return 'No sessions found.';
    }
    const header = '| Session ID | Events | Messages | Status | Created | Updated | Agents ';
    const separator = '|---|---|---|---|---|---|---|';
    const rows = output.sessions.map((session) => {
        const agents = session.agentsUsed.length > 0 ? session.agentsUsed.join(', ') : 'none';
        const status =
            session.awaiting === undefined ? session.status : `${session.status}/${session.awaiting.reason}`;
        return `| ${session.sessionId} | ${session.eventCount} | ${session.messageCount} | ${status} | ${session.createdAt ?? 'N/A'} | ${session.updatedAt ?? 'N/A'} | ${agents} |`;
    });
    const hint = output.truncated ? `\n[truncated; pass a smaller date window or lower limit for more]` : '';
    return [header, separator, ...rows].join('\n') + hint;
}

export function createSessionListToolRegistration(
    options?: SessionToolsOptions,
): ToolRegistration<SessionListInput, SessionListOutput> {
    return {
        name: 'session_list',
        description:
            'List durable mission-control sessions with optional date filtering. Returns session id, event count, message count, status, and timestamps. Read-only; no approval.',
        capabilityClasses: ['read'],
        parametersJsonSchema: sessionListParametersJsonSchema,
        inputSchema: sessionListInputSchema,
        outputSchema: sessionListOutputSchema,
        outputLimit: { maxModelOutputChars: OUTPUT_LIMIT_CHARS },
        execute: async (input) => {
            const ids = await listSessionIds(options);
            const summaries = await collectSummaries(ids, options);
            const filtered = filterByDate(summaries, input.from_date, input.to_date);
            const limit = input.limit ?? DEFAULT_LIMIT;
            const truncated = filtered.length > limit;
            return { sessions: filtered.slice(0, limit), truncated };
        },
        toModelOutput: formatSessionListModelOutput,
    };
}

async function collectSummaries(
    ids: readonly string[],
    options?: SessionToolsOptions,
): Promise<readonly SessionSummary[]> {
    const results = await Promise.all(
        ids.map(async (id): Promise<SessionSummary | undefined> => {
            const read = await readSessionProjection(id, options);
            if (read.kind !== 'found' || read.projection === undefined) {
                return undefined;
            }
            return summarizeProjection(id, read.projection, {
                ...(read.status !== undefined ? { status: read.status } : {}),
                ...(read.awaiting !== undefined ? { awaiting: read.awaiting } : {}),
                ...(read.updatedAt !== undefined ? { updatedAt: read.updatedAt } : {}),
                ...(read.parentSessionId !== undefined ? { parentSessionId: read.parentSessionId } : {}),
                ...(read.title !== undefined ? { title: read.title } : {}),
                ...(read.category !== undefined ? { category: read.category } : {}),
                ...(read.agentName !== undefined ? { agentName: read.agentName } : {}),
            });
        }),
    );
    return results.filter((summary): summary is SessionSummary => summary !== undefined);
}

function filterByDate(
    summaries: readonly SessionSummary[],
    fromDate: string | undefined,
    toDate: string | undefined,
): readonly SessionSummary[] {
    if (fromDate === undefined && toDate === undefined) {
        return summaries;
    }
    const from = fromDate !== undefined ? parseDateBoundary(fromDate) : null;
    const to = toDate !== undefined ? parseDateBoundary(toDate) : null;
    return summaries.filter((summary) => {
        const anchor = summary.updatedAt ?? summary.createdAt;
        if (anchor === undefined) {
            return false;
        }
        const when = Date.parse(anchor);
        if (Number.isNaN(when)) {
            return false;
        }
        if (from !== null && when < from) {
            return false;
        }
        if (to !== null && when > to) {
            return false;
        }
        return true;
    });
}

function parseDateBoundary(value: string): number {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

// Re-exported to keep the session-id validation surface reachable from callers/tests.
export { normalizeSessionId };
