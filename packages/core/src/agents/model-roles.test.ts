import { describe, expect, it } from 'vitest';
import type { ModelRole } from './model-roles.js';
import {
    formatModelAlias,
    LEGACY_CATEGORY_MODEL_ALIASES,
    MODEL_ROLE_ALIAS_PREFIX,
    MODEL_ROLE_IDS,
    MODEL_ROLES,
    parseModelAlias,
} from './model-roles.js';

describe('model-roles', () => {
    describe('parseModelAlias', () => {
        it('returns the role when input is a known mctrl/<role> alias', () => {
            expect(parseModelAlias('mctrl/smol')).toBe('smol');
        });

        it('returns undefined when input has no mctrl/ prefix', () => {
            expect(parseModelAlias('smol')).toBeUndefined();
        });

        it('returns undefined when the prefixed role is unknown', () => {
            expect(parseModelAlias('mctrl/unknown')).toBeUndefined();
        });

        it('returns undefined for the bare prefix with no role', () => {
            expect(parseModelAlias(MODEL_ROLE_ALIAS_PREFIX)).toBeUndefined();
        });
    });

    describe('formatModelAlias', () => {
        it('formats a role as mctrl/<role>', () => {
            expect(formatModelAlias('slow')).toBe('mctrl/slow');
        });
    });

    describe('format/parse round-trip', () => {
        it('restores every known role through format then parse', () => {
            for (const role of MODEL_ROLE_IDS) {
                const alias = formatModelAlias(role);
                expect(parseModelAlias(alias)).toBe(role);
            }
        });

        it('exposes exactly the 10 ModelRole values', () => {
            const typedKeys = Object.keys(MODEL_ROLES) as ModelRole[];
            expect(MODEL_ROLE_IDS).toHaveLength(10);
            expect(typedKeys).toEqual(MODEL_ROLE_IDS);
        });
    });

    describe('LEGACY_CATEGORY_MODEL_ALIASES', () => {
        it('maps opus to slow', () => {
            expect(LEGACY_CATEGORY_MODEL_ALIASES.opus).toBe('slow');
        });

        it('maps sonnet to default', () => {
            expect(LEGACY_CATEGORY_MODEL_ALIASES.sonnet).toBe('default');
        });
    });
});
