# ADR-003: Chat streaming via fetch POST + manual SSE parsing

**Status:** Accepted

## Context

Native browser `EventSource` is GET-oriented and cannot send a request body.
The chat endpoint (`POST /api/v1/chat`) needs a POST body —
`conversationId`, `content` (up to 32k chars), `modelId`, `classification`,
`documentIds` — to authorize and initiate the stream.

## Decision

The client (`frontend/src/api.ts`, `streamChat`) initiates chat with
`fetch()` POST, `accept: text/event-stream`, reads the response body via
`getReader()`, and parses SSE frames manually (`parseSseFrame`). A 401
triggers one token-refresh retry before failing.

Do not describe or document this as "EventSource" — that misleads future
implementers into a GET-based design that cannot carry the request body.

## Consequences

- The server streams named events (`meta`, `delta`, `notice`, `done`,
  `error`) plus `: ping` heartbeats over the hijacked response
  (`backend/src/chat/routes.ts`).
- Client code owns framing/parsing; any new client (mobile, CLI) must
  implement the same frame protocol, documented in `docs/api.md`.
- Server shutdown explicitly ends hijacked SSE streams
  (`closeActiveSseStreams`, wired into Fastify `preClose` in
  `backend/src/server.ts`).
