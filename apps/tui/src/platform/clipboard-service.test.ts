import { ClipboardTarget } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import { createClipboardService } from './clipboard-service.js';

describe('createClipboardService', () => {
    it('copies via copyToClipboardOSC52 with ClipboardTarget.Clipboard when OSC52 is supported', async () => {
        const calls: Array<[string, ClipboardTarget | undefined]> = [];
        const renderer = {
            copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean {
                calls.push([text, target]);
                return true;
            },
            isOsc52Supported(): boolean {
                return true;
            },
        };

        const service = createClipboardService(renderer);
        const ok = await service.copyToClipboard('hi');

        expect(ok).toBe(true);
        expect(calls).toEqual([['hi', ClipboardTarget.Clipboard]]);
        expect(service.isOsc52Supported()).toBe(true);
    });

    it('resolves false and never touches the OSC52 path when unsupported', async () => {
        const calls: Array<[string, ClipboardTarget | undefined]> = [];
        const renderer = {
            copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean {
                calls.push([text, target]);
                return true;
            },
            isOsc52Supported(): boolean {
                return false;
            },
        };

        const service = createClipboardService(renderer);
        const ok = await service.copyToClipboard('hi');

        expect(ok).toBe(false);
        expect(calls).toEqual([]);
        expect(service.isOsc52Supported()).toBe(false);
    });

    it('forwards the underlying OSC52 boolean result', async () => {
        const renderer = {
            copyToClipboardOSC52(): boolean {
                return false;
            },
            isOsc52Supported(): boolean {
                return true;
            },
        };

        const service = createClipboardService(renderer);
        const ok = await service.copyToClipboard('ignored');

        expect(ok).toBe(false);
    });
});
