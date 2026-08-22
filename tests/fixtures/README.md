# Captured wire fixtures

`workflow-stream-success.bin` and `workflow-stream-failed.bin` are **verbatim
response bodies** from a live Mastra dev server (server `1.25.1`, `mastra`
`1.60.0`), captured on 2026-08-21 from:

```
POST /api/workflows/:workflowId/create-run          -> {"runId": "..."}
POST /api/workflows/:workflowId/stream?runId=<id>   -> the bytes in these files
```

The workflow used was a throwaway probe whose step writes two real
`plan-execution-event` objects and then either returns or throws. That is why
the step is named `probe-step`: these are recordings, not hand-written samples,
and they are deliberately left exactly as they arrived.

They exist because Mastra's streaming format is not documented. The bytes are
the specification `src/app/lib/stream-protocol.ts` is written against — in
particular that records are separated by U+001E and contain **no newlines**,
which is the detail a hand-written NDJSON fixture would have quietly gotten
wrong.

Do not reformat these files. Re-capture them if Mastra changes.
