import { z } from 'zod';

export const ABG_NODE_KINDS = [
    'condition',
    'action',
    'selector',
    'sequence',
    'parallel',
    'race',
    'join',
    'watch',
    'policy',
    'statechart',
    'actor',
    'memory',
    'tool',
    'llm',
    'human-approval',
] as const;

export const ABG_NODE_STATUSES = [
    'idle',
    'starting',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'blocked',
] as const;

export const ABG_GRAPH_STATUSES = ['created', 'active', 'blocked', 'completed', 'failed', 'cancelled'] as const;

export const AbgNodeKindSchema = z.enum(ABG_NODE_KINDS);
export type AbgNodeKind = z.infer<typeof AbgNodeKindSchema>;

export const AbgNodeStatusSchema = z.enum(ABG_NODE_STATUSES);
export type AbgNodeStatus = z.infer<typeof AbgNodeStatusSchema>;

export const AbgGraphStatusSchema = z.enum(ABG_GRAPH_STATUSES);
export type AbgGraphStatus = z.infer<typeof AbgGraphStatusSchema>;
