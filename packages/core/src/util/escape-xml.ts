/**
 * Escapes the XML-significant characters (`&`, `<`, `>`) so a string can be
 * safely embedded into the XML-flavoured blocks used by system-prompt assembly
 * and the workflow tool output.
 */
export function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
