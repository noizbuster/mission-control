import { describe, expect, it, vi } from 'vitest';
import {
    attachRendererResizeSync,
    parseTmuxPaneSize,
    type RendererResizeTarget,
    readTerminalSize,
    readTmuxPaneSize,
    syncRendererToTerminalSize,
    type TerminalResizeSource,
} from './opentui-renderer.js';
import { EventEmitter } from 'node:events';

class FakeTerminalStream extends EventEmitter implements TerminalResizeSource {
    readonly columns?: number;
    readonly rows?: number;
    private windowSize: readonly [number, number] | undefined;

    constructor(columns: number | undefined, rows: number | undefined) {
        super();
        if (columns !== undefined) this.columns = columns;
        if (rows !== undefined) this.rows = rows;
    }

    setWindowSize(columns: number, rows: number): void {
        this.windowSize = [columns, rows];
    }

    getWindowSize(): readonly [number, number] {
        if (this.windowSize !== undefined) return this.windowSize;
        return [this.columns ?? 0, this.rows ?? 0];
    }
}

class RecordingRenderer implements RendererResizeTarget {
    width: number;
    height: number;
    readonly calls: Array<readonly [number, number]> = [];
    renderRequests = 0;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    resize(width: number, height: number): void {
        this.calls.push([width, height]);
        this.width = width;
        this.height = height;
    }

    requestRender(): void {
        this.renderRequests += 1;
    }
}

describe('opentui renderer resize sync', () => {
    it('parses tmux pane size output defensively', () => {
        expect(parseTmuxPaneSize('140 40\n')).toEqual({ columns: 140, rows: 40 });
        expect(parseTmuxPaneSize('140')).toBeUndefined();
        expect(parseTmuxPaneSize('0 40')).toBeUndefined();
        expect(parseTmuxPaneSize('wide tall')).toBeUndefined();
    });

    it('reads tmux pane size when TMUX_PANE is available', () => {
        expect(readTmuxPaneSize({ TMUX_PANE: '%7' }, (paneId) => `${paneId === '%7' ? 140 : 80} 40`)).toEqual({
            columns: 140,
            rows: 40,
        });
        expect(readTmuxPaneSize({}, () => '140 40')).toBeUndefined();
        expect(readTmuxPaneSize({ TMUX_PANE: '%7' }, () => 'bad')).toBeUndefined();
    });

    it('prefers live TTY window size over stale columns and rows', () => {
        const stream = new FakeTerminalStream(80, 24);
        stream.setWindowSize(100, 28);

        expect(readTerminalSize(stream)).toEqual({ columns: 100, rows: 28 });
    });

    it('prefers an explicit terminal size probe over stale nested PTY size', () => {
        const stream = new FakeTerminalStream(100, 28);

        expect(readTerminalSize(stream, () => ({ columns: 140, rows: 40 }))).toEqual({ columns: 140, rows: 40 });
    });

    it('resizes the renderer when the terminal dimensions changed', () => {
        const stream = new FakeTerminalStream(80, 24);
        const renderer = new RecordingRenderer(80, 24);
        stream.setWindowSize(140, 40);

        expect(syncRendererToTerminalSize(renderer, stream)).toBe(true);
        expect(syncRendererToTerminalSize(renderer, stream)).toBe(false);

        expect(renderer.calls).toEqual([[140, 40]]);
        expect(renderer.renderRequests).toBe(1);
        expect(Reflect.get(renderer, 'forceFullRepaintRequested')).toBe(true);
    });

    it('subscribes to stream resize events and detaches cleanly', () => {
        const stream = new FakeTerminalStream(80, 24);
        const renderer = new RecordingRenderer(80, 24);
        const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 0 });

        stream.setWindowSize(100, 28);
        stream.emit('resize');
        detach();
        stream.setWindowSize(120, 32);
        stream.emit('resize');

        expect(renderer.calls).toEqual([[100, 28]]);
    });

    it('polls terminal size when resize events are not emitted and stops polling after detach', () => {
        vi.useFakeTimers();
        try {
            const stream = new FakeTerminalStream(80, 24);
            const renderer = new RecordingRenderer(80, 24);
            const detach = attachRendererResizeSync(renderer, stream, { pollIntervalMs: 10 });

            stream.setWindowSize(140, 40);
            vi.advanceTimersByTime(10);
            detach();
            stream.setWindowSize(160, 50);
            vi.advanceTimersByTime(10);

            expect(renderer.calls).toEqual([[140, 40]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('polls with the explicit size probe when the stream size is stale', () => {
        vi.useFakeTimers();
        try {
            const stream = new FakeTerminalStream(100, 28);
            const renderer = new RecordingRenderer(100, 28);
            let probedSize = { columns: 100, rows: 28 };
            const detach = attachRendererResizeSync(renderer, stream, {
                pollIntervalMs: 10,
                sizeProbe: () => probedSize,
            });

            probedSize = { columns: 140, rows: 40 };
            vi.advanceTimersByTime(10);
            detach();

            expect(renderer.calls).toEqual([[140, 40]]);
        } finally {
            vi.useRealTimers();
        }
    });
});
