# OpenAI Responses Mapping

Verified against official OpenAI documentation on 2026-06-09.

Sources:

- https://platform.openai.com/docs/guides/migrate-to-responses
- https://platform.openai.com/docs/guides/streaming-responses
- https://platform.openai.com/docs/guides/function-calling
- https://platform.openai.com/docs/api-reference/responses-streaming/response

Provider-neutral stream chunk mapping:

- response.created -> response_started
- response.output_text.delta -> text_delta
- response.function_call_arguments.delta -> tool_call_delta
- response.function_call_arguments.done -> tool_call_completed
- response.output_item.done -> tool_call_completed when the completed item is a function call
- response.completed -> response_completed
- response.failed -> response_failed

Adapter constraints for the later provider implementation:

- Use the Responses API, not Chat Completions, for the first OpenAI adapter.
- Request streaming through server-sent events.
- Keep request storage disabled by default with `store: false`.
- Resolve credentials through `ProviderCredentialResolver`; do not read CLI or desktop credential stores from core.
- Do not serialize raw provider credentials into protocol events, JSONL logs, errors, CLI output, desktop data, or evidence.
