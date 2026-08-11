/**
 * ACP `messageId` bookkeeping for streamed assistant content.
 *
 * ## Why this exists
 *
 * `ContentChunk.messageId` groups streamed chunks into one logical message:
 * "All chunks belonging to the same message share the same `messageId`.
 * A change in `messageId` indicates a new message has started."
 *
 * Adapters that omit it force clients to guess message boundaries. Clients that
 * group strictly by id then render **every delta as its own message** — a reply
 * streamed as 20 deltas shows up as 20 separate bubbles. This is exactly what
 * JetBrains clients do (their reducer starts a new element whenever `messageId`
 * is null), while Zed happens to tolerate the omission, which is why the gap
 * went unnoticed.
 *
 * Reference adapters do stamp it: `claude-agent-acp` reuses the provider's API
 * message id, `codex-acp` threads an optional id through its chunk factories.
 *
 * ## Why a counter instead of an id from pi
 *
 * pi's `AssistantMessage` has no `id`/`uuid`. Its only stable-looking field,
 * `responseId`, is populated **only on `message_end`** — at `message_start` the
 * key is absent (`stopReason: "pending"`, `content: []`). Since the id is needed
 * when the *first* delta is emitted, there is nothing to borrow, so we mint our
 * own. ACP message ids are opaque strings, so any stable value is spec-legal.
 *
 * ## Turn / tool-call boundaries
 *
 * pi opens a **new** message around tool calls: a single ACP turn that calls a
 * tool yields several `message_start` events (the user prompt, an assistant
 * message carrying the tool call, the tool result, then a fresh assistant
 * message for the remaining text). Messages are never nested — each
 * `message_start` is closed by its `message_end` before the next one opens —
 * so minting on `message_start` and clearing on `message_end` assigns distinct
 * ids either side of a tool call automatically.
 *
 * Clearing is not cosmetic. A client that appends to the *last* assistant
 * message it has seen (rather than the immediately preceding element) would
 * splice post-tool text back into the pre-tool bubble if the id were reused,
 * reordering the transcript. Emitting no id is always safe: it just starts a new
 * message.
 *
 * Only genuine model output is stamped. Adapter-authored notices (retry,
 * compaction, queue) stay unstamped so they never merge into the model's reply.
 */

/** Tracks the id of the assistant message currently being streamed. */
export class MessageIdTracker {
  private readonly prefix: string
  private counter = 0
  private current: string | undefined

  /**
   * @param prefix Namespace for generated ids, normally the ACP session id, so
   * ids stay distinct across concurrent sessions sharing a client.
   */
  constructor(prefix: string) {
    this.prefix = prefix
  }

  /**
   * Starts a new assistant message and returns its id.
   *
   * Call on `message_start` with `role === 'assistant'`. Messages with other
   * roles are pi's own bookkeeping (user echo, tool results) and must not
   * disturb the current id.
   */
  begin(): string {
    this.counter += 1
    this.current = `${this.prefix}/msg-${this.counter}`
    return this.current
  }

  /**
   * Ends the current message so the next chunk cannot join it.
   *
   * Call on `message_end` of any role — pi never nests messages, so any message
   * ending means the assistant's message is over — and whenever a turn is torn
   * down, so a cancelled or failed turn never leaks its id into the next one.
   */
  end(): void {
    this.current = undefined
  }

  /**
   * Id for the message being streamed, or `undefined` when no message is open.
   *
   * `undefined` is a valid state, not an error: deltas can arrive outside any
   * open message — after a turn was interrupted, or once an adapter notice has
   * closed the message. The chunk is then emitted without an id and simply
   * forms its own message.
   */
  get(): string | undefined {
    return this.current
  }
}

/**
 * Builds an `agent_message_chunk` / `agent_thought_chunk` payload, attaching
 * `messageId` only when one is open.
 *
 * The field is omitted rather than set to `undefined` so serialized
 * notifications stay byte-identical to the unstamped form when no message is
 * open — clients (and tests) never see an explicit `messageId: undefined`.
 */
export function contentChunk(
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
  messageId: string | undefined
): {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'
  content: { type: 'text'; text: string }
  messageId?: string
} {
  return {
    sessionUpdate,
    content: { type: 'text', text },
    // Omitted rather than set to `undefined`: an explicit key would alter the
    // serialized notification. Compared against `undefined` (not truthiness) so
    // a caller-supplied empty id is preserved rather than silently dropped.
    ...(messageId !== undefined ? { messageId } : {})
  }
}
