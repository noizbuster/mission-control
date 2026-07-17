export function decodeImageBase64(value: string): Uint8Array {
    const cleaned = value.startsWith('data:') ? (value.split(',', 2)[1] ?? value) : value;
    const buffer = Buffer.from(cleaned, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
