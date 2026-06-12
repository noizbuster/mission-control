export class SidecarProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SidecarProtocolError';
    }
}
