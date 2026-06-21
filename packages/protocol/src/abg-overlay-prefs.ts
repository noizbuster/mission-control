import { z } from 'zod';

export const AbgOverlayPrefsSchema = z.object({
    activeTabIndex: z.number().int().nonnegative().default(0),
    scrollOffset: z.number().int().nonnegative().default(0),
    liveOutput: z.boolean().default(true),
    showThinking: z.boolean().default(false),
    toolOutputExpanded: z.boolean().default(false),
});
export type AbgOverlayPrefs = z.infer<typeof AbgOverlayPrefsSchema>;
