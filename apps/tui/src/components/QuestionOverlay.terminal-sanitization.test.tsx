/** @jsxImportSource @opentui/solid */
import { testRender } from '@opentui/solid';
import { describe, expect, it } from 'vitest';
import { createChatStore } from '../state/chat-store';
import { QuestionOverlay } from './OverlayPanels';

const OSC8 = '\u001B]8;;https://attacker.invalid\u0007';
const CSI = '\u001B[2J';
const C1_CSI = '\u009B2J';
const BIDI = '\u202E';
const CREDENTIAL = 'sk-displayblocker123';

function hasUnsafeTerminalControl(frame: string): boolean {
    return Array.from(frame).some((character) => {
        const codePoint = character.codePointAt(0) ?? -1;
        return (
            (codePoint <= 0x1f && codePoint !== 0x0a) ||
            (codePoint >= 0x7f && codePoint <= 0x9f) ||
            codePoint === 0x061c ||
            codePoint === 0x200e ||
            codePoint === 0x200f ||
            (codePoint >= 0x202a && codePoint <= 0x202e) ||
            (codePoint >= 0x2066 && codePoint <= 0x2069)
        );
    });
}

function expectTerminalControlsToBeAbsent(frame: string): void {
    expect(hasUnsafeTerminalControl(frame), frame).toBe(false);
    expect(frame).not.toContain(OSC8);
    expect(frame).not.toContain(CSI);
    expect(frame).not.toContain(C1_CSI);
    expect(frame).not.toContain(BIDI);
}

function expectTerminalControlsToBeEscaped(frame: string): void {
    expectTerminalControlsToBeAbsent(frame);
    expect(frame).toContain('\\u{001B}');
    expect(frame).toContain('\\u{0007}');
    expect(frame).toContain('\\u{009B}');
    expect(frame).toContain('\\u{202E}');
}

function expectCredentialToBeRedacted(frame: string): void {
    expect(frame).toContain('[REDACTED_CREDENTIAL]');
    expect(frame).not.toContain(CREDENTIAL);
}

describe('QuestionOverlay terminal sanitization', () => {
    it('sanitizes the question, header, option, and description while resolving the raw selected answer', async () => {
        const store = createChatStore();
        const header = `案内 ${CREDENTIAL}${OSC8}`;
        const question = `質問 ${CREDENTIAL} 一行目\n二行目 家族\u200D絵${CSI}${BIDI}`;
        const answer = `選択肢 ${CREDENTIAL}${C1_CSI}`;
        const description = `説明 ${CREDENTIAL}${BIDI}`;
        const selection = store.showQuestion(question, [{ label: answer, description }], { header });
        const setup = await testRender(() => <QuestionOverlay store={store} />, { width: 96, height: 18 });

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(frame).toContain('案内');
            expect(frame).toContain('質問');
            expect(frame).toMatch(/一行目[^\n]*\n[^\n]*二行目/u);
            expect(frame).toContain('家族\u200D絵');
            expect(frame).toContain('選択肢');
            expect(frame).toContain('説明');
            expectCredentialToBeRedacted(frame);
            expectTerminalControlsToBeEscaped(frame);

            store.selectQuestionByClick(0);
            await expect(selection).resolves.toBe(answer);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('sanitizes the custom buffer while resolving the byte-exact raw answer', async () => {
        const store = createChatStore();
        const custom = `カスタム ${CREDENTIAL} 一行目\n二行目 家族\u200D絵${OSC8}${BIDI}`;
        const selection = store.showQuestion('質問', ['既定']);
        store.enterQuestionCustomMode();
        store.appendQuestionCustom(custom);
        const setup = await testRender(() => <QuestionOverlay store={store} />, { width: 96, height: 18 });

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(frame).toContain('カスタム');
            expect(frame).toMatch(/一行目[^\n]*\n[^\n]*二行目/u);
            expect(frame).toContain('家族\u200D絵');
            expectCredentialToBeRedacted(frame);
            expectTerminalControlsToBeAbsent(frame);

            store.submitCustomAnswer(store.getSnapshot().questionCustomBuffer);
            await expect(selection).resolves.toBe(custom);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('sanitizes batch multiple answers while resolving their byte-exact raw values', async () => {
        const store = createChatStore();
        const answer = `回答 ${CREDENTIAL} 一行目\n二行目 家族\u200D絵${C1_CSI}${BIDI}`;
        const selection = store.showQuestionBatch([
            {
                header: `一括 ${CREDENTIAL}${OSC8}`,
                question: `質問 ${CREDENTIAL}${CSI}`,
                options: [{ label: answer, description: `説明 ${CREDENTIAL}${BIDI}` }],
                multiple: true,
            },
        ]);
        store.selectQuestionByClick(0);
        store.navigateQuestionTab(1);
        const setup = await testRender(() => <QuestionOverlay store={store} />, { width: 96, height: 18 });

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(frame).toContain('回答');
            expect(frame).toMatch(/一行目[^\n]*\n[^\n]*二行目/u);
            expect(frame).toContain('家族\u200D絵');
            expectCredentialToBeRedacted(frame);
            expectTerminalControlsToBeAbsent(frame);

            store.confirmQuestionBatch();
            await expect(selection).resolves.toEqual([answer]);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('renders every progress step for a two-question batch', async () => {
        const store = createChatStore();
        // Given a two-question batch.
        store.showQuestionBatch([
            { header: 'First', question: 'First question', options: [{ label: 'First answer' }], multiple: false },
            { header: 'Second', question: 'Second question', options: [{ label: 'Second answer' }], multiple: false },
        ]);
        const firstSetup = await testRender(() => <QuestionOverlay store={store} />, { width: 96, height: 18 });
        try {
            // Then the first question is the first rendered step.
            await firstSetup.renderOnce();
            expect(firstSetup.captureCharFrame()).toContain('Question (1/3)');
        } finally {
            firstSetup.renderer.destroy();
        }

        // When the first question is answered, the second tab renders next.
        store.selectQuestionByClick(0);
        const secondSetup = await testRender(() => <QuestionOverlay store={store} />, { width: 96, height: 18 });
        try {
            await secondSetup.renderOnce();
            expect(secondSetup.captureCharFrame()).toContain('Question (2/3)');
        } finally {
            secondSetup.renderer.destroy();
        }

        // When the second question is answered, Confirm is the final step.
        store.selectQuestionByClick(0);
        const confirmSetup = await testRender(() => <QuestionOverlay store={store} />, { width: 96, height: 18 });
        try {
            await confirmSetup.renderOnce();
            expect(confirmSetup.captureCharFrame()).toContain('Question (3/3)');
        } finally {
            confirmSetup.renderer.destroy();
        }
    });
});
