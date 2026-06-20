import { afterEach, describe, expect, it } from 'vitest';
import { EvalContextManager } from './eval-context-manager.js';

const managers: EvalContextManager[] = [];

function createManager(): EvalContextManager {
    const manager = new EvalContextManager();
    managers.push(manager);
    return manager;
}

describe('EvalContextManager', () => {
    afterEach(async () => {
        const pending = managers.splice(0, managers.length);
        await Promise.allSettled(pending.map((manager) => manager.close()));
    });

    it('returns the completion value of a simple expression', async () => {
        const manager = createManager();
        const result = await manager.runCode({ code: '1 + 1' });
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.truncated).toBe(false);
        expect(result.output).toContain('2');
    });

    it('persists var declarations across runCode calls', async () => {
        const manager = createManager();
        const first = await manager.runCode({ code: 'var x = 42' });
        expect(first.exitCode).toBe(0);
        const second = await manager.runCode({ code: 'x' });
        expect(second.exitCode).toBe(0);
        expect(second.output).toContain('42');
    });

    it('captures console output', async () => {
        const manager = createManager();
        const result = await manager.runCode({ code: 'console.log("hello")' });
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('hello');
    });

    it('terminates the worker and reports a timeout for an infinite loop', async () => {
        const manager = createManager();
        const result = await manager.runCode({ code: 'while (true) {}', timeoutMs: 200 });
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).not.toBe(0);
    });

    it('clears persisted state after reset', async () => {
        const manager = createManager();
        await manager.runCode({ code: 'var x = 42' });
        const before = await manager.runCode({ code: 'x' });
        expect(before.output).toContain('42');
        await manager.reset();
        const after = await manager.runCode({ code: 'x' });
        expect(after.exitCode).not.toBe(0);
        expect(after.output).toContain('not defined');
    });

    it('surfaces thrown errors in the output with a non-zero exit code', async () => {
        const manager = createManager();
        const result = await manager.runCode({ code: 'throw new Error("test")' });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain('test');
    });

    it('flags output that exceeds the cap as truncated', async () => {
        const manager = createManager();
        const code = 'var s = ""; for (var i = 0; i < 100000; i += 1) { s += "x"; } s';
        const result = await manager.runCode({ code });
        expect(result.exitCode).toBe(0);
        expect(result.truncated).toBe(true);
        expect(result.output.length).toBeLessThanOrEqual(64 * 1024);
    });

    it('returns a closed error after close is called', async () => {
        const manager = createManager();
        await manager.close();
        const result = await manager.runCode({ code: '1 + 1' });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain('closed');
    });
});
