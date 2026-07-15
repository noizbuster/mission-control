import { describe, expect, it } from 'vitest';
import { BrowserHarness, createRegistration } from './browser-tool-lifecycle-test-support.js';
import { ToolRegistry } from './tool-registry.js';

describe('browser screenshot observability', () => {
    it('keeps capped base64 private while preserving it in structured output', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);
        if (registration === null) throw new Error('browser registration unavailable');
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration);

        const settlement = await registry.invoke({
            toolCallId: 'screenshot-call',
            toolName: advertisement.name,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ action: 'screenshot' }),
        });
        await registration.close();

        expect(settlement.structuredOutput).toMatchObject({ screenshotBase64: 'AQID', screenshotBytes: 3 });
        expect(settlement.modelOutput?.content).toContain('browser screenshot (3 bytes)');
        expect(settlement.modelOutput?.content).not.toContain('AQID');
        expect(settlement.result.output).not.toContain('AQID');
    });
});
