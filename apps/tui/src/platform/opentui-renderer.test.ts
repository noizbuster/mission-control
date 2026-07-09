import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'opentui-renderer.ts');

describe('opentui renderer mount (OpenCode-aligned)', () => {
    it('uses createCliRenderer + render only — no custom resize drivers', () => {
        const source = readFileSync(sourcePath, 'utf8');
        expect(source).toContain('createCliRenderer');
        expect(source).toContain('await render(app, renderer)');
        expect(source).toContain('targetFps: 60');
        expect(source).not.toContain('attachRendererResizeSync');
        expect(source).not.toContain('setInterval');
        expect(source).not.toContain('forceFullRepaint');
        expect(source).not.toContain('scheduleWidthGrow');
        expect(source).not.toContain('hardReset');
        expect(source).not.toContain('process.on');
    });
});
