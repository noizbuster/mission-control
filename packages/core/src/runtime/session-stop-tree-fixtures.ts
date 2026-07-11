export type SessionStopTreeFixtureSession = {
    readonly sessionId: string;
    readonly parentSessionId: string | null;
    readonly rootSessionId?: string | null;
};

export type SessionStopTreeFixtureRelation = {
    readonly parentSessionId: string | null;
    readonly childSessionId: string;
    readonly kind: string;
};

export type SessionStopTreeSharedFixture = {
    readonly name: string;
    readonly targetSessionId: string;
    readonly sessions: readonly SessionStopTreeFixtureSession[];
    readonly relations: readonly SessionStopTreeFixtureRelation[];
    readonly expectedParents?: Readonly<Record<string, string | null>>;
    readonly expectedErrorCode?: 'unstable_session_tree';
};

export const SESSION_STOP_TREE_SHARED_FIXTURES: readonly SessionStopTreeSharedFixture[] = [
    {
        name: 'explicit-parent-wins-and-relation-fallback',
        targetSessionId: 'mc-tree-root',
        sessions: [
            { sessionId: 'mc-tree-root', parentSessionId: null },
            {
                sessionId: 'mc-tree-explicit',
                parentSessionId: 'mc-tree-root',
                rootSessionId: 'ignored-root-metadata',
            },
            { sessionId: 'mc-tree-fallback', parentSessionId: null },
        ],
        relations: [
            { parentSessionId: 'ignored-relation-parent', childSessionId: 'mc-tree-explicit', kind: 'subagent' },
            { parentSessionId: 'mc-tree-explicit', childSessionId: 'mc-tree-fallback', kind: 'parent_child' },
            { parentSessionId: 'mc-tree-root', childSessionId: 'mc-tree-fallback', kind: 'fork' },
        ],
        expectedParents: {
            'mc-tree-root': null,
            'mc-tree-explicit': 'mc-tree-root',
            'mc-tree-fallback': 'mc-tree-explicit',
        },
    },
    {
        name: 'multiple-fallback-is-unstable',
        targetSessionId: 'mc-tree-root',
        sessions: [
            { sessionId: 'mc-tree-root', parentSessionId: null },
            { sessionId: 'mc-tree-other', parentSessionId: null },
            { sessionId: 'mc-tree-child', parentSessionId: null },
        ],
        relations: [
            { parentSessionId: 'mc-tree-root', childSessionId: 'mc-tree-child', kind: 'parent_child' },
            { parentSessionId: 'mc-tree-other', childSessionId: 'mc-tree-child', kind: 'subagent' },
        ],
        expectedErrorCode: 'unstable_session_tree',
    },
    {
        name: 'explicit-cycle-is-unstable',
        targetSessionId: 'mc-cycle-a',
        sessions: [
            { sessionId: 'mc-cycle-a', parentSessionId: 'mc-cycle-b' },
            { sessionId: 'mc-cycle-b', parentSessionId: 'mc-cycle-a' },
        ],
        relations: [],
        expectedErrorCode: 'unstable_session_tree',
    },
] as const;
