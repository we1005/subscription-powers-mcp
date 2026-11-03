# Third-party notices

## can1357/oh-my-pi

Parts of `server/lib/codex-wire.mjs`, `server/lib/codex-api.mjs` and `server/lib/codex-auth.mjs` are adapted from
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (commit `0b5c27a`), translated from TypeScript/Bun to plain Node ESM
and simplified. The adapted parts are:

| Our file | Adapted from (oh-my-pi) | What |
|---|---|---|
| `server/lib/codex-wire.mjs` | `packages/catalog/src/wire/codex.ts`, `packages/ai/src/providers/openai-codex-responses.ts` | base URL / `/codex/responses` resolution, JWT claim decoding (account id, plan, residency), request-header set, SSE error extraction and status classification |
| `server/lib/codex-api.mjs` | `packages/coding-agent/src/web/search/providers/codex.ts` | request body (`web_search` tool, `tool_choice`, `include`), SSE event state machine, source extraction and de-duplication, `utm_source=openai` cleanup, the "no web_search_call ⇒ not a search result" guard, retry / rate-limit budget ideas |
| `server/lib/codex-auth.mjs` | `packages/coding-agent/src/web/search/providers/codex.ts` (credential selection) | the idea of reading the Codex login; ours is a deliberately read-only variant |

The original license text follows, as required by its terms.

---

MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
