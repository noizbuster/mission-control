<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# util

## Purpose

Tiny shared TypeScript utilities used across core: unknown-error stringification, XML escaping, and Node.js errno helpers.

## Key Files

| File | Description |
|------|-------------|
| `error-to-string.ts` | `errorToString` — stable message extraction (avoids `[object Object]`) |
| `escape-xml.ts` | `escapeXml` for XML/HTML text nodes |
| `node-error.ts` | `isNodeError`, `isErrorCode`, `isMissingPathError` |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Prefer `errorToString` over inline `instanceof Error ? … : String(error)`.
- Keep functions dependency-free and pure.
- Do not grow this into a general junk drawer — new helpers need multiple call sites.

### Testing Requirements

- Currently covered via callers; add focused tests if behavior branches grow

### Common Patterns

- Narrow `unknown` at boundaries; detect `ENOENT` via `isMissingPathError`

## Dependencies

### Internal

- Wide callers across core/tools/runtime

### External

- None

<!-- MANUAL: -->
