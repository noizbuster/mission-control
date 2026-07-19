export type TerminalTextSegment = {
    readonly segment: string;
    readonly index: number;
};

type OpenCluster = {
    readonly index: number;
    text: string;
    hasExtendedPictograph: boolean;
    awaitsPictograph: boolean;
    regionalIndicatorCount: number;
};

const combiningMarkRegex = /\p{Mark}/u;
const extendedPictographRegex = /\p{Extended_Pictographic}/u;

export function fallbackSegmentTerminalText(value: string): readonly TerminalTextSegment[] {
    const segments: TerminalTextSegment[] = [];
    let cluster: OpenCluster | undefined;
    let index = 0;

    const flush = (): void => {
        if (cluster === undefined) return;
        segments.push({ segment: cluster.text, index: cluster.index });
        cluster = undefined;
    };
    const start = (scalar: string, offset: number): void => {
        const codePoint = scalar.codePointAt(0);
        cluster = {
            index: offset,
            text: scalar,
            hasExtendedPictograph: isExtendedPictograph(scalar),
            awaitsPictograph: false,
            regionalIndicatorCount: codePoint !== undefined && isRegionalIndicator(codePoint) ? 1 : 0,
        };
    };

    for (const scalar of value) {
        const codePoint = scalar.codePointAt(0);
        if (codePoint === undefined) continue;

        if (scalar === '\n' && cluster?.text === '\r') {
            cluster.text += scalar;
            flush();
        } else if (scalar === '\r') {
            flush();
            start(scalar, index);
        } else if (isControl(codePoint)) {
            flush();
            start(scalar, index);
            flush();
        } else if (cluster === undefined) {
            start(scalar, index);
        } else if (cluster.awaitsPictograph && isExtendedPictograph(scalar)) {
            cluster.text += scalar;
            cluster.hasExtendedPictograph = true;
            cluster.awaitsPictograph = false;
        } else if (isExtension(codePoint, scalar)) {
            cluster.text += scalar;
            cluster.awaitsPictograph = false;
        } else if (codePoint === 0x200d && cluster.hasExtendedPictograph) {
            cluster.text += scalar;
            cluster.awaitsPictograph = true;
        } else if (isRegionalIndicator(codePoint) && cluster.regionalIndicatorCount === 1) {
            cluster.text += scalar;
            cluster.regionalIndicatorCount += 1;
            flush();
        } else {
            flush();
            start(scalar, index);
        }
        index += scalar.length;
    }

    flush();
    return segments;
}

function isControl(codePoint: number): boolean {
    return codePoint < 32 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isExtension(codePoint: number, scalar: string): boolean {
    return (
        combiningMarkRegex.test(scalar) ||
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
        (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
        (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
    );
}

function isExtendedPictograph(scalar: string): boolean {
    return extendedPictographRegex.test(scalar);
}

function isRegionalIndicator(codePoint: number): boolean {
    return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}
