# add-session-search

## TL;DR

Add a `mctrl session search <query>` command that searches across durable JSONL session messages and returns matching excerpts with session IDs and timestamps. The search reads existing session logs without modification and surfaces results through the plain, Ink, and JSON renderers. This is a reference example demonstrating the `writePlan` output format — `## TL;DR`, `## TODOs` (unchecked checkboxes), and `## Final Verification Wave` (reviewer checkboxes). The checkbox lines are all at column 0 so `parsePlanChecklistText` can count them on round-trip.

## TODOs

- [ ] Add `SessionSearchResult` schema to `packages/protocol/src/schema.ts`
- [ ] Implement `searchSessions(query, root)` in `packages/core/src/memory/`
- [ ] Wire `session search <query>` subcommand in `apps/cli/src/commands/`
- [ ] Add plain and JSON renderer output for search result entries
- [ ] Write unit tests for the query matcher (case-insensitive, substring, boundary)
- [ ] Write integration test that searches a seeded temp session log

## Final Verification Wave

- [ ] Reviewer: confirm each result entry includes session ID, message timestamp, and matching excerpt
- [ ] Reviewer: confirm `--json` output validates against `SessionSearchResult` schema
- [ ] Reviewer: confirm empty query returns a helpful usage error instead of dumping every session
- [ ] Reviewer: confirm no session JSONL logs are mutated or locked during a search
- [ ] Reviewer: confirm read-only repo tool path guards still reject `temp/ref-repos` during search
