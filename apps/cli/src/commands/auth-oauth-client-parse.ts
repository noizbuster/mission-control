export type DeviceCodeResponse = {
    readonly verificationUri: string;
    readonly userCode: string;
    readonly deviceCode: string;
    readonly interval: number | undefined;
};

export type GitHubTokenPoll = {
    readonly accessToken: string | undefined;
    readonly error: string | undefined;
    readonly interval: number | undefined;
};

export type OpenAIHeadlessCode = {
    readonly deviceAuthID: string;
    readonly userCode: string;
    readonly interval: string | undefined;
};

export type OpenAIHeadlessToken = {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
};

export type OAuthTokenResponse = {
    readonly accessToken: string;
    readonly refreshToken: string | undefined;
    readonly expiresIn: number | undefined;
    readonly idToken: string | undefined;
};

type JsonRecord = Readonly<Record<string, unknown>>;

export function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
    const record = parseRecord(value, 'device code response');
    return {
        verificationUri: requiredURL(record, 'verification_uri'),
        userCode: requiredString(record, 'user_code'),
        deviceCode: requiredString(record, 'device_code'),
        interval: optionalPositiveNumber(record, 'interval'),
    };
}

export function parseGitHubTokenPoll(value: unknown): GitHubTokenPoll {
    const record = parseRecord(value, 'GitHub token response');
    return {
        accessToken: optionalString(record, 'access_token'),
        error: optionalString(record, 'error'),
        interval: optionalPositiveNumber(record, 'interval'),
    };
}

export function parseOpenAIHeadlessCode(value: unknown): OpenAIHeadlessCode {
    const record = parseRecord(value, 'OpenAI device response');
    return {
        deviceAuthID: requiredString(record, 'device_auth_id'),
        userCode: requiredString(record, 'user_code'),
        interval: optionalString(record, 'interval'),
    };
}

export function parseOpenAIHeadlessToken(value: unknown): OpenAIHeadlessToken {
    const record = parseRecord(value, 'OpenAI device token response');
    return {
        authorizationCode: requiredString(record, 'authorization_code'),
        codeVerifier: requiredString(record, 'code_verifier'),
    };
}

export function parseOAuthTokenResponse(value: unknown): OAuthTokenResponse {
    const record = parseRecord(value, 'OAuth token response');
    return {
        accessToken: requiredString(record, 'access_token'),
        refreshToken: optionalString(record, 'refresh_token'),
        expiresIn: optionalPositiveNumber(record, 'expires_in'),
        idToken: optionalString(record, 'id_token'),
    };
}

export function extractAccountLabel(idToken: string): string | undefined {
    const parts = idToken.split('.');
    const payload = parts[1];
    if (parts.length !== 3 || payload === undefined) {
        return undefined;
    }
    try {
        const claims = parseRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), 'id token claims');
        return optionalString(claims, 'email') ?? optionalString(claims, 'chatgpt_account_id');
    } catch (error: unknown) {
        if (error instanceof SyntaxError || error instanceof OAuthParseError) {
            return undefined;
        }
        throw error;
    }
}

class OAuthParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OAuthParseError';
    }
}

function parseRecord(value: unknown, label: string): JsonRecord {
    if (!isJsonRecord(value)) {
        throw new OAuthParseError(`Invalid ${label}`);
    }
    return value;
}

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredURL(record: JsonRecord, key: string): string {
    const value = requiredString(record, key);
    try {
        return new URL(value).href;
    } catch (error: unknown) {
        if (error instanceof TypeError) {
            throw new OAuthParseError(`Invalid ${key}`);
        }
        throw error;
    }
}

function requiredString(record: JsonRecord, key: string): string {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new OAuthParseError(`Missing ${key}`);
    }
    return value;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalPositiveNumber(record: JsonRecord, key: string): number | undefined {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
