import { type PersistentMemoryStore, TursoPersistentStore } from '@mission-control/core';
import type { CliArgs } from '../args';
import { assertUnreachable } from '../assert-unreachable';
import { type AgentUIRenderer, JsonRenderer, PlainRenderer } from '../ui/renderers';

export function closePersistentStore(store: PersistentMemoryStore | undefined): void {
    if (store instanceof TursoPersistentStore) {
        store.close();
    }
}

export function createRenderer(mode: CliArgs['mode'], thinking = false): AgentUIRenderer {
    switch (mode) {
        case 'plain':
        case 'tui':
            return new PlainRenderer({ thinking });
        case 'json':
        case 'jsonl':
            return new JsonRenderer();
        default:
            return assertUnreachable(mode, 'CLI mode');
    }
}
