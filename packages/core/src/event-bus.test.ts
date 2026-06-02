import { describe, expect, it } from 'vitest';
import { EventBus } from './event-bus.js';

describe('EventBus', () => {
    it('subscribe receives events and unsubscribe stops delivery', () => {
        const bus = new EventBus<string>();
        const received: string[] = [];

        const unsubscribe = bus.subscribe((event) => {
            received.push(event);
        });

        bus.emit('first');
        unsubscribe();
        bus.emit('second');

        expect(received).toEqual(['first']);
    });
});
