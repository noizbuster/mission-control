import { describe, expect, it, vi } from 'vitest';
import { attachResizeFullPaint } from './opentui-renderer.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'opentui-renderer.ts');

describe('opentui renderer mount (OpenTUI Solid)', () => {
    it('registers full-paint after render and uses microtask', () => {
        const source = readFileSync(sourcePath, 'utf8');
        expect(source).toContain('createCliRenderer');
        expect(source).toContain('await render(app, renderer)');
        expect(source).toContain('attachResizeFullPaint');
        expect(source.indexOf('await render(app, renderer)')).toBeLessThan(
            source.indexOf('attachResizeFullPaint(renderer)'),
        );
        expect(source).toContain('queueMicrotask');
        expect(source).toContain('forceFullRepaintRequested');
        expect(source).not.toContain("process.on('SIGWINCH'");
        expect(source).not.toContain('hardReset');
    });

    it('attachResizeFullPaint sets force flag on microtask', async () => {
        const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        const renderer = {
            on: (event: string, listener: (...args: unknown[]) => void) => {
                const set = listeners.get(event) ?? new Set();
                set.add(listener);
                listeners.set(event, set);
            },
            off: (event: string, listener: (...args: unknown[]) => void) => {
                listeners.get(event)?.delete(listener);
            },
            requestRender: vi.fn(),
            resize: vi.fn(),
        };
        const detach = attachResizeFullPaint(renderer as never);
        for (const listener of listeners.get('resize') ?? []) {
            listener(120, 40);
        }
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBeUndefined();
        await Promise.resolve();
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
        expect(renderer.requestRender).toHaveBeenCalledTimes(1);
        expect(renderer.resize).not.toHaveBeenCalled();
        detach();
        expect(listeners.get('resize')?.size ?? 0).toBe(0);
    });
});
