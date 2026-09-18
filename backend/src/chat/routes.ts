import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantQuery } from '../db/pool.js';
import { Errors, AppError } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, Classification, AuthContext } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import { applyContextWindow, GatewayTelemetry, ProviderToolDefinition, streamMetadata } from '../ai/gateway/gateway.js';
import { getApprovedModelForUser } from '../ai/gateway/modelRegistry.js';
import { resolveCapabilityModel, type CapabilityResolution } from '../ai/gateway/capabilityRouter.js';
import { retrieveAuthorizedContext } from '../rag/retrieval.js';
import { recordAudit } from '../audit/audit.js';
import { toolRegistry, zodToJsonSchema } from '../tools/gateway.js';
import { buildSystemPrompt, wrapRetrievedContext, buildNoEvidenceNotice } from './systemPrompt.js';
import { detectCapability } from './capabilityDetect.js';
import { runAgenticLoop, type AgenticLoopSink } from './agenticLoop.js';
import { assembleCodeContext, normalizeCodeFiles } from './codeContext.js';
import { canModelProcess } from '../policy/engine.js';
import { config } from '../config.js';
import { createChatConcurrencyLimiter, replyBusy } from '../ai/gateway/limits.js';
import { recordChatTurn, recordRetrieval } from '../observability/metrics.js';
import { DlpStreamGuard } from '../dlp/streamGuard.js';

const chatBodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(32000),
  modelId: z.string().uuid().optional(),
  // Optional: when /chat creates a conversation, an omitted classification
  // resolves to the caller's clearance floor (PUBLIC for public-only callers).
  classification: z.enum(CLASSIFICATIONS).optional(),
  documentIds: z.array(z.string().uuid()).max(100).optional(),
  // Optional capability hint for Phase 6 routing ('chat' | 'syteline' |
  // 'coding' | 'embeddings'). When omitted the turn's capability is detected
  // from the message text. An explicit modelId still wins over routing.
  capability: z.enum(['chat', 'syteline', 'coding', 'embeddings']).optional(),
  // Optional repo files for grounded coding help ("explain this code").
  // Assembled into a path-labeled, budget-capped context block; the model
  // must cite these paths and never invent others.
  codeFiles: z.array(z.object({
    path: z.string().min(1).max(256),
    content: z.string().min(1).max(200000),
  })).max(20).optional(),
}).strict();

const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Concurrency limiter for chat streams (Phase 4b gateway fairness): one slot
 * per in-flight stream, held for the whole SSE response including agentic
 * tool rounds and released on close/error/abort. Exported for tests and
 * operational introspection.
 */
export const chatConcurrency = createChatConcurrencyLimiter();

/**
 * Active hijacked SSE responses. Hijacked responses are not tracked by the
 * HTTP server, so `server.close()` cannot drain them on its own — a client
 * that keeps a stream open would stall shutdown indefinitely. Shutdown ends
 * these explicitly (see `closeActiveSseStreams`, called from a `preClose`
 * hook in server.ts).
 */
interface ActiveSseStream {
  end: () => void;
  abort: () => void;
}
const activeSseStreams = new Set<ActiveSseStream>();

export function closeActiveSseStreams(): void {
  for (const stream of activeSseStreams) {
    try {
      stream.abort();
    } catch {
      // Provider stream already finished; ending the response is enough.
    }
    try {
      stream.end();
    } catch {
      // Client already gone.
    }
  }
  activeSseStreams.clear();
}

/**
 * Minimal surface of the hijacked raw response the SSE sender needs, so
 * tests can drive it with a fake socket.
 */
export interface SseRawSocket {
  write(chunk: string): boolean;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  once(event: 'drain' | 'close', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
}

export interface SseSenderOptions {
  /** Max bytes buffered for a slow consumer before the stream is aborted. */
  maxPendingBytes?: number;
  /** How long to wait for 'drain' before treating the consumer as dead. */
  drainTimeoutMs?: number;
  /** Also releases a pending drain wait (provider abort / shutdown). */
  abortSignal?: AbortSignal;
}

export interface SseSender {
  /**
   * Sends one SSE frame. Resolves true when the frame was accepted;
   * resolves false when the client is gone or too slow — the caller must
   * stop producing events and tear the stream down.
   */
  send(event: string, data: unknown): Promise<boolean>;
  /** Best-effort heartbeat comment; never blocks and never grows the buffer. */
  ping(): void;
  /** True after the pending cap or drain timeout tripped. */
  readonly backpressureAborted: boolean;
  /** Bytes currently counted as buffered for a slow consumer. */
  pendingBytes(): number;
}

// Cap on bytes buffered for a slow SSE consumer before the stream is
// aborted. ~1 MiB holds tens of thousands of typical delta frames, yet one
// hung client cannot grow server memory without bound. The cap is
// per-connection: it bounds a single stalled consumer, not total server
// memory (see the `send` accounting below).
const DEFAULT_SSE_MAX_PENDING_BYTES = 1024 * 1024;
// How long to wait for the socket 'drain' event before treating the consumer
// as dead. Long enough to ride out transient stalls, short enough that a
// dead client does not pin a provider request indefinitely.
const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Backpressure-aware SSE frame writer.
 *
 * Node's `write()` returns false when the socket buffer is full; ignoring
 * that (as the old code did) lets a slow or dead client buffer an unbounded
 * number of frames in server memory. This sender instead:
 * - counts bytes queued while backpressured and aborts past the cap,
 * - waits for 'drain' with a timeout before sending more,
 * - treats heartbeats as droppable keepalives that never queue behind data.
 */
export function createSseSender(raw: SseRawSocket, options: SseSenderOptions = {}): SseSender {
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_SSE_MAX_PENDING_BYTES;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_SSE_DRAIN_TIMEOUT_MS;
  let pendingBytes = 0;
  let backpressureAborted = false;

  function dead(): boolean {
    return backpressureAborted || raw.writableEnded || raw.destroyed;
  }

  function waitForDrain(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        raw.off('drain', onDrain);
        raw.off('close', onClose);
        options.abortSignal?.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      const onDrain = () => done(true);
      const onClose = () => done(false);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), drainTimeoutMs);
      // A dead stream must not keep the event loop alive on its own.
      (timer as unknown as { unref?: () => void }).unref?.();
      raw.once('drain', onDrain);
      raw.once('close', onClose);
      options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function send(event: string, data: unknown): Promise<boolean> {
    if (dead()) return false;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let accepted: boolean;
    try {
      accepted = raw.write(frame);
    } catch {
      return false;
    }
    if (accepted) {
      // The kernel buffer has room again: reset the slow-consumer accounting
      // so a long healthy stream can never trip the cap.
      pendingBytes = 0;
      return true;
    }
    // Slow consumer: the socket buffer is full. Count what we queued and
    // abort past the cap so one hung client cannot grow memory without bound.
    pendingBytes += frame.length;
    if (pendingBytes > maxPendingBytes) {
      backpressureAborted = true;
      return false;
    }
    const drained = await waitForDrain();
    if (!drained || dead()) {
      backpressureAborted = true;
      return false;
    }
    pendingBytes = 0;
    return true;
  }

  function ping(): void {
    // Heartbeats are keepalive comments, not data: never queue one behind a
    // slow consumer — skip the beat instead of growing the buffer. A ping
    // written while the socket is already full still counts toward the cap
    // so a client that never drains trips the abort instead of buffering
    // heartbeats forever.
    if (dead() || pendingBytes > 0) return;
    try {
      if (!raw.write(': ping\n\n')) {
        pendingBytes += ': ping\n\n'.length;
        if (pendingBytes > maxPendingBytes) backpressureAborted = true;
      }
    } catch {
      // Client is gone; the abort listener and finally block handle cleanup.
    }
  }

  return {
    send,
    ping,
    get backpressureAborted() {
      return backpressureAborted;
    },
    pendingBytes: () => pendingBytes,
  };
}

/**
 * Builds the OpenAI-compatible tool definitions offered to the model for this
 * turn. Only tools the caller is permitted to use AND whose classification
 * policy admits the turn's classification are exposed — the model can never
 * talk the server into running a tool the user couldn't run directly.
 */
function buildProviderTools(auth: AuthContext, classification: Classification): ProviderToolDefinition[] {
  if (!auth.permissions.includes('tool:use')) return [];
  return toolRegistry
    // Per-tool permission is enforced in application code here, at offer
    // time, and again inside runToolCall at execution time: the model can
    // never talk the server into running a tool the user couldn't run
    // directly (e.g. syteline:read-gated ERP tools for a caller who only
    // has generic tool:use).
    .filter((tool) => auth.permissions.includes(tool.permission ?? 'tool:use'))
    .filter((tool) => canModelProcess(classification, tool.allowedClassifications).allowed)
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema),
      },
    }));
}

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/chat', {
    preHandler: [requireAuth, requirePermission('chat:create')],
    // Sustained request rate (config CHAT_RATE_LIMIT_PER_MIN). The stream is
    // long-lived, so burst protection for provider cost also comes from the
    // concurrency cap below. Documented in docs/deployment.md.
    config: { rateLimit: { max: config.CHAT_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const turnStart = Date.now();
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid chat request body', parsed.error.format());

    let conversationId = parsed.data.conversationId;
    let modelId = parsed.data.modelId;
    // Clearance-aware default for newly created conversations: a PUBLIC caller
    // omitting classification gets PUBLIC, not INTERNAL (which they are not
    // cleared for). Existing conversations keep their stored classification.
    let classification = (parsed.data.classification ?? (auth.clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL')) as Classification;
    if (conversationId) {
      const conversation = (
        await tenantQuery<{ model: string; classification: Classification }>(
          auth.tenantId,
          `SELECT COALESCE(model_id, (SELECT id FROM models WHERE name = conversations.model))::text AS model,
                  classification FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
          [conversationId, auth.tenantId, auth.userId]
        )
      ).rows[0];
      if (!conversation) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      modelId ??= conversation.model;
      classification = conversation.classification;
    }
    // A caller may not self-assert a classification above their clearance, even
    // for a conversation they own (clearances can be lowered after creation).
    assertClassificationAllowed(auth.clearance, classification);
    // Tools offered this turn (permission + classification filtered): needed
    // before model resolution so capability detection knows whether the
    // SyteLine family is actually available to this caller.
    const providerTools = buildProviderTools(auth, classification);
    const sytelineToolsOffered = providerTools.some((tool) => tool.function.name.startsWith('syteline.'));
    // Phase 6 capability routing: an explicit `capability` on the request
    // wins; otherwise the turn's capability is detected from its own text.
    const requestedCapability = parsed.data.capability ?? detectCapability(parsed.data.content, { sytelineToolsOffered });
    let capabilityResolution: CapabilityResolution | undefined;
    if (!modelId) {
      // Capability-routed model: the best authorized model for the turn's
      // capability, with audited fallback to the chat default when the
      // capability model is unavailable. The user never sees this machinery
      // — they just get better answers faster.
      capabilityResolution = await resolveCapabilityModel({
        tenantId: auth.tenantId,
        userId: auth.userId,
        roleId: auth.roleId,
        capability: requestedCapability,
        requestId: req.requestId,
      });
      modelId = capabilityResolution.model.id;
    }
    if (!modelId) throw Errors.forbidden('NO_APPROVED_MODEL', 'No approved model is available');
    const model = await getApprovedModelForUser(modelId, auth.tenantId, auth.userId, auth.roleId);

    if (!conversationId) {
      conversationId = (
        await tenantQuery<{ id: string }>(
          auth.tenantId,
          `INSERT INTO conversations (tenant_id, user_id, title, model, model_id, classification)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [auth.tenantId, auth.userId, parsed.data.content.slice(0, 80), model.name, modelId, classification]
        )
      ).rows[0]!.id;
    }

    const history = (
      await tenantQuery<{ role: 'user' | 'assistant' | 'system'; content: string }>(
        auth.tenantId,
        `SELECT role, content FROM messages WHERE conversation_id = $1 AND tenant_id = $2
         AND role IN ('user','assistant','system') ORDER BY created_at DESC LIMIT 50`,
        [conversationId, auth.tenantId]
      )
    ).rows.reverse();
    await tenantQuery(
      auth.tenantId,
      `INSERT INTO messages (conversation_id, tenant_id, role, content, model, model_id) VALUES ($1,$2,'user',$3,$4,$5)`,
      [conversationId, auth.tenantId, parsed.data.content, model.name, modelId]
    );
    history.push({ role: 'user', content: parsed.data.content });

    let citations: Awaited<ReturnType<typeof retrieveAuthorizedContext>>['citations'] = [];
    if (parsed.data.documentIds?.length) {
      const retrievalStart = Date.now();
      let retrieval: Awaited<ReturnType<typeof retrieveAuthorizedContext>>;
      try {
        retrieval = await retrieveAuthorizedContext(auth, parsed.data.content, parsed.data.documentIds);
      } catch (error) {
        recordRetrieval('error', (Date.now() - retrievalStart) / 1000);
        throw error;
      }
      recordRetrieval(retrieval.context ? 'hit' : 'empty', (Date.now() - retrievalStart) / 1000);
      citations = retrieval.citations;
      if (retrieval.context) {
        history.pop();
        // Zone 3 of the system prompt: labeled, delimited, untrusted data.
        history.push({ role: 'user', content: wrapRetrievedContext(retrieval.context) });
        history.push({ role: 'user', content: parsed.data.content });
      } else {
        // Retrieval was requested but returned nothing: instruct the model to
        // answer honestly ("I don't know from the available sources") rather
        // than hallucinate document contents.
        history.push({ role: 'user', content: buildNoEvidenceNotice() });
      }
      await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'RAG_RETRIEVAL', resource: 'documents', classification, metadata: { resultCount: citations.length } });
    }

    // Phase 6 coding workflows: caller-supplied repo files are assembled
    // into a path-labeled, budget-capped block (zone 3b, untrusted data) so
    // "explain this code" answers stay grounded in real file contents. The
    // block is inserted before the current user turn, like RAG context.
    const codeFileInputs = parsed.data.codeFiles ? normalizeCodeFiles(parsed.data.codeFiles) : [];
    let codeFilesIncluded: string[] = [];
    let codeFilesDropped: Array<{ path: string; reason: string }> = [];
    if (codeFileInputs.length > 0) {
      const assembled = assembleCodeContext(codeFileInputs);
      codeFilesIncluded = assembled.filesIncluded;
      codeFilesDropped = assembled.dropped;
      if (assembled.context) {
        const userTurn = history.pop()!;
        history.push({ role: 'user', content: assembled.context });
        history.push(userTurn);
      }
    }

    // The charter-encoded system prompt for this turn: behavioral spec (§2),
    // labeled content zones, and tenant-safe model metadata (name/version
    // only — never secrets). The gateway pins it at index 0 of every
    // provider call and re-adds it after each truncation round, so it is
    // never dropped no matter how long the history grows.
    const sytelineToolsAvailable = providerTools.some((tool) => tool.function.name.startsWith('syteline.'));
    // Coding turns get the CODING WORK section: ground claims in shown files,
    // never invent paths or APIs, deliver changes as unified diffs.
    const codingMode = requestedCapability === 'coding' || codeFileInputs.length > 0;
    const buildTurnSystemPrompt = (modelName: string, modelVersion?: string) =>
      buildSystemPrompt({
        modelName,
        modelVersion,
        toolsAvailable: providerTools.length > 0,
        sytelineToolsAvailable,
        codingMode,
      });
    const chatSystemPrompt = buildTurnSystemPrompt(model.name, model.version);

    // Context-window management: sliding window that always keeps the system
    // prompt and the most recent turns. The drop count is surfaced in `meta`
    // so truncation is never silent.
    const windowed = applyContextWindow(history, model.context_window, undefined, chatSystemPrompt);
    if (windowed.dropped > 0) {
      req.log.info({ requestId: req.requestId, conversationId, dropped: windowed.dropped }, 'context window truncated oldest messages');
    }

    // Concurrency cap (gateway fairness): acquire one slot before the stream
    // starts and hold it for the whole SSE response, released in the finally
    // below on normal close, error, client abort, or server shutdown. The
    // check happens BEFORE reply.hijack() so an over-capacity request gets a
    // normal JSON 429 instead of a half-hijacked stream. Nothing between the
    // acquire and the try block below early-returns; everything that can
    // throw or await (DB, gateway, tool calls) lives inside it, so the slot
    // cannot leak.
    const concurrencySlot = chatConcurrency.tryAcquire(auth.tenantId, auth.userId);
    if (!concurrencySlot.ok) {
      recordChatTurn(model.name, 'rate_limited', (Date.now() - turnStart) / 1000);
      return replyBusy(reply, concurrencySlot.retryAfterSeconds);
    }

    // Take over the raw response for SSE. hijack() is required: without it
    // Fastify would attempt to serialize the handler's return value after the
    // raw writes, corrupting the stream.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'x-request-id': req.requestId,
    });
    const abortController = new AbortController();
    // Set when the socket closes before we finished the response: the client
    // went away mid-stream, so the partial turn must persist as interrupted —
    // never as a clean completion.
    let clientDisconnected = false;
    // Set once the terminal `done` frame was accepted: a socket close after
    // that is a normal post-response close, not a mid-stream disconnect.
    let doneDelivered = false;
    const onSocketClose = () => {
      // The socket also closes after a normal response; only a close before
      // the response finished means the client disconnected mid-stream.
      if (!reply.raw.writableEnded && !doneDelivered) {
        clientDisconnected = true;
        abortController.abort();
      }
    };
    req.raw.socket.once('close', onSocketClose);
    // Register the hijacked response so shutdown can end it explicitly.
    const activeStream: ActiveSseStream = {
      end: () => {
        if (!reply.raw.writableEnded) reply.raw.end();
      },
      abort: () => abortController.abort(),
    };
    activeSseStreams.add(activeStream);
    const sse = createSseSender(reply.raw as unknown as SseRawSocket, {
      abortSignal: abortController.signal,
    });
    /**
     * Backpressure-aware frame send. Resolves false when the client is gone
     * or too slow: the caller must stop producing events. The provider
     * request is aborted too — there is nobody left to read the answer, and
     * the partial turn must not persist as a completed message.
     */
    const send = async (event: string, data: unknown): Promise<boolean> => {
      const ok = await sse.send(event, data);
      if (!ok) {
        if (sse.backpressureAborted) {
          req.log.warn(
            { requestId: req.requestId, conversationId, pendingBytes: sse.pendingBytes() },
            'SSE consumer too slow; aborting provider stream'
          );
        }
        abortController.abort();
      }
      return ok;
    };
    // Heartbeats keep intermediaries from closing idle streams during long
    // provider pauses; SSE comments are ignored by EventSource clients.
    // Guarded and self-clearing: a destroyed socket must not raise from the
    // timer or leak the interval.
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        clearInterval(heartbeat);
        return;
      }
      sse.ping();
      if (sse.backpressureAborted) {
        // The client never drains, not even heartbeats: treat it as gone.
        clearInterval(heartbeat);
        req.log.warn({ requestId: req.requestId, conversationId }, 'SSE consumer stalled; aborting provider stream');
        abortController.abort();
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (!(await send('meta', {
      conversationId,
      model: { id: model.id, name: model.name },
      citations,
      contextDropped: windowed.dropped,
      // Telemetry for operators: which capability served and whether the
      // chat default covered for a missing capability model. Not user-facing.
      capability: capabilityResolution
        ? { requested: capabilityResolution.requested, resolved: capabilityResolution.resolved, fallbackUsed: capabilityResolution.fallbackUsed }
        : undefined,
      codeFiles: codeFileInputs.length > 0 ? { included: codeFilesIncluded, dropped: codeFilesDropped } : undefined,
    }))) {
      // Nobody is listening; skip straight to persistence/cleanup.
      abortController.abort();
    }

    const telemetry: GatewayTelemetry = {};
    // DLP outbound boundary (Phase 5c): every assistant text chunk passes
    // through the stream guard before reaching the client or the persisted
    // transcript. The loop tallies detections for the turn-end audit; matched
    // text is never persisted or logged.
    const dlpGuard = config.DLP_ENABLED ? new DlpStreamGuard(!!config.DLP_EXTERNAL_ENDPOINT) : null;

    const sink: AgenticLoopSink = {
      text: (delta) => send('delta', { content: delta }),
      // Brief plan narration before each tool round (Phase 6 loop contract).
      plan: (planText, toolNames) => send('notice', { code: 'TOOL_PLAN', message: planText, tools: toolNames }),
      toolCalls: (calls) =>
        send('notice', {
          code: 'TOOL_CALLS',
          message: `Running ${calls.length} tool call${calls.length === 1 ? '' : 's'}…`,
          tools: calls.map((call) => call.name),
        }),
      failover: (modelName, failoverModelId) =>
        send('notice', {
          code: 'MODEL_FAILOVER',
          message: `Primary model unavailable; continued with ${modelName}`,
          model: { id: failoverModelId, name: modelName },
        }),
      done: async (payload) => {
        doneDelivered = await send('done', { ...payload, citations });
        return doneDelivered;
      },
      error: async (code, message) => {
        await send('error', { code, message, requestId: req.requestId });
      },
    };

    // The generalized agentic loop (Phase 6): bounded tool rounds with
    // per-step audit, dependent chaining, brief plan narration, and an
    // approval gate that keeps destructive tools out of auto-execution.
    // Everything that can throw or await lives inside the try below, so the
    // concurrency slot acquired above cannot leak.
    // Both the try and the catch assign loopResult before the finally runs.
    let loopResult!: Awaited<ReturnType<typeof runAgenticLoop>>;
    try {
      loopResult = await runAgenticLoop({
        tenantId: auth.tenantId,
        userId: auth.userId,
        roleId: auth.roleId,
        requestId: req.requestId,
        classification,
        auth,
        initialModel: { id: modelId, name: model.name, contextWindow: model.context_window, version: model.version },
        buildSystemPrompt: buildTurnSystemPrompt,
        providerTools,
        messages: windowed.messages,
        signal: abortController.signal,
        telemetry,
        maxIterations: config.AI_MAX_TOOL_ITERATIONS,
        maxResponseChars: config.AI_MAX_RESPONSE_CHARS,
        dlpGuard,
        sink,
        capabilityResolved: capabilityResolution?.resolved,
        capabilityFallbackUsed: capabilityResolution?.fallbackUsed,
      });
    } catch (error) {
      // The loop surfaces stream errors through the sink; a throw here is a
      // defect in the loop machinery itself — log it, mark the turn failed,
      // and tell the client honestly instead of hanging the stream.
      req.log.error({ err: error }, 'agentic loop threw unexpectedly');
      await send('error', { code: 'STREAM_ERROR', message: 'Model request failed', requestId: req.requestId });
      loopResult = {
        content: '',
        finishReason: 'error',
        toolIterations: 0,
        truncatedByCap: false,
        servingModel: { id: modelId, name: model.name },
        interrupted: false,
        failed: true,
        aborted: abortController.signal.aborted,
        completed: false,
        dlpDetections: [],
      };
    } finally {
      // Release the concurrency slot first: the stream is over (normal close,
      // error, abort, or shutdown), so the next waiting request may proceed.
      concurrencySlot.release();
      clearInterval(heartbeat);
      // The response uses Connection: keep-alive, so the socket can serve
      // later requests: remove the per-request listener or each request leaks
      // a closure retaining reply, the abort controller, and request flags.
      req.raw.socket.off('close', onSocketClose);
      activeSseStreams.delete(activeStream);
      // The loop reports the model that actually served the turn: after a
      // mid-turn failover the transcript names the fallback model, not the
      // failed primary.
      const servingModelId = loopResult.servingModel.id;
      const servingModelName = loopResult.servingModel.name;
      const content = loopResult.content;
      // Set when the stream errored after partial output was produced: the
      // persisted message gets stream_interrupted metadata so a truncated
      // reply is never mistaken for a finished one.
      const streamInterrupted = loopResult.interrupted;
      // Set when the loop's run threw: the turn outcome for metrics is
      // 'error' even when no partial content was produced.
      const turnFailed = loopResult.failed;
      const dlpDetections = loopResult.dlpDetections;
      // Domain RED metric for the turn: outcome reflects what the user
      // experienced (completed / error / aborted by disconnect).
      recordChatTurn(
        servingModelName,
        clientDisconnected ? 'aborted' : turnFailed || streamInterrupted ? 'error' : 'completed',
        (Date.now() - turnStart) / 1000,
        telemetry.timeToFirstTokenMs !== undefined ? telemetry.timeToFirstTokenMs / 1000 : undefined
      );
      if (content) {
        // Stream status travels in metadata, never in the message text: a
        // reconnecting client reading history can distinguish a completed
        // answer from one cut short by a provider error, a client
        // disconnect, or a stalled consumer. (A deliberate length-cap cut
        // still counts as completed: the terminal `done` frame told the live
        // client why via finishReason.)
        const interrupted = !doneDelivered && (streamInterrupted || clientDisconnected || sse.backpressureAborted);
        await tenantQuery(
          auth.tenantId,
          `INSERT INTO messages (conversation_id, tenant_id, role, content, model, model_id, citations, metadata)
           VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7)`,
          [conversationId, auth.tenantId, content, servingModelName, servingModelId, JSON.stringify(citations), JSON.stringify(streamMetadata(interrupted ? 'interrupted' : 'completed'))]
        ).catch((error) => req.log.error({ err: error }, 'Failed to persist assistant message'));
        await tenantQuery(auth.tenantId, 'UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND tenant_id = $2', [conversationId, auth.tenantId]);
        if (dlpDetections.length > 0) {
          // DLP audit: kinds and counts only — matched text is never logged.
          const counts: Record<string, number> = {};
          for (const kind of dlpDetections) counts[kind] = (counts[kind] ?? 0) + 1;
          await recordAudit({
            action: 'DLP_DETECTION',
            classification: 'INTERNAL',
            tenantId: auth.tenantId,
            userId: auth.userId,
            requestId: req.requestId,
            success: true,
            metadata: { counts, redactedSpans: dlpDetections.length },
          }).catch((error) => req.log.error({ err: error }, 'Failed to audit DLP detection'));
        }
      }
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
