import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

/**
 * `messageId` groups streamed chunks into logical messages. Clients that group
 * strictly by id render every unstamped delta as its own message, so a reply is
 * only rendered as one bubble when all of its chunks share an id — and text
 * either side of a tool call must NOT share one.
 */

function newSession(sessionId = 's1') {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc }
}

const flush = () => new Promise(r => setTimeout(r, 0))

const assistantStart = { type: 'message_start', message: { role: 'assistant' } }
const textDelta = (delta: string) => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta }
})

/** messageId of the nth update, or undefined when unstamped. */
function messageIdAt(conn: FakeAgentSideConnection, index: number): string | undefined {
  return (conn.updates[index]!.update as { messageId?: string }).messageId
}

test('PiAcpSession: chunks of one message share a messageId', async () => {
  const { conn, proc } = newSession()

  proc.emit(assistantStart)
  proc.emit(textDelta('Hel'))
  proc.emit(textDelta('lo'))

  await flush()

  assert.equal(conn.updates.length, 2)
  const first = messageIdAt(conn, 0)
  assert.ok(first, 'chunk should carry a messageId once a message has started')
  assert.equal(messageIdAt(conn, 1), first)
})

test('PiAcpSession: a new message gets a different messageId', async () => {
  const { conn, proc } = newSession()

  proc.emit(assistantStart)
  proc.emit(textDelta('first'))
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })

  proc.emit(assistantStart)
  proc.emit(textDelta('second'))

  await flush()

  assert.equal(conn.updates.length, 2)
  assert.notEqual(messageIdAt(conn, 0), messageIdAt(conn, 1))
})

test('PiAcpSession: text before and after a tool call gets distinct messageIds', async () => {
  const { conn, proc } = newSession()

  // pi wraps tool calls in their own messages: assistant text, assistant tool
  // call, tool result, then a fresh assistant message for the remaining text.
  proc.emit(assistantStart)
  proc.emit(textDelta('before'))
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })

  proc.emit({ type: 'message_start', message: { role: 'toolResult' } })
  proc.emit({ type: 'message_end', message: { role: 'toolResult' } })

  proc.emit(assistantStart)
  proc.emit(textDelta('after'))

  await flush()

  const texts = conn.updates.map(u => (u.update as any).content?.text)
  assert.deepEqual(texts, ['before', 'after'])

  // Sharing an id here would let a client append "after" to the pre-tool
  // bubble, reordering the transcript around the tool call.
  assert.notEqual(messageIdAt(conn, 0), messageIdAt(conn, 1))
})

test('PiAcpSession: text after message_end is not stamped with the closed id', async () => {
  const { conn, proc } = newSession()

  proc.emit(assistantStart)
  proc.emit(textDelta('inside'))
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  // A stray delta after the message closed: reusing the just-closed id would
  // append it to a message the client already considers finished.
  proc.emit(textDelta('stray'))

  await flush()

  assert.ok(messageIdAt(conn, 0), 'in-message chunk should be stamped')
  assert.equal(messageIdAt(conn, 1), undefined, 'chunk after message_end must not reuse the id')
})

test('PiAcpSession: a new turn does not reuse an id left open by the previous one', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // First turn is abandoned mid-message: `message_end` never arrives.
  const first = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit(assistantStart)
  proc.emit(textDelta('interrupted'))
  await flush()
  // `startTurn` also emits `session_info_update`, so locate the chunk by text.
  const interrupted = conn.updates.find(u => (u.update as any).content?.text === 'interrupted')
  const staleId = (interrupted?.update as { messageId?: string } | undefined)?.messageId
  assert.ok(staleId, 'first turn should stamp its text')

  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  await first

  // Second turn streams text before any `message_start` of its own.
  const before = conn.updates.length
  void session.prompt('again')
  await flush()
  proc.emit(textDelta('next turn'))
  await flush()

  const stray = conn.updates.slice(before).find(u => (u.update as any).content?.text === 'next turn')
  assert.ok(stray, 'expected the second turn to emit its text')
  assert.equal(
    (stray!.update as { messageId?: string }).messageId,
    undefined,
    'a new turn must not inherit the previous turn\'s open messageId'
  )
})

test('PiAcpSession: thought and text chunks of one message share a messageId', async () => {
  const { conn, proc } = newSession()

  proc.emit(assistantStart)
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' }
  })
  proc.emit(textDelta('answer'))

  await flush()

  assert.equal(conn.updates.length, 2)
  assert.equal((conn.updates[0]!.update as any).sessionUpdate, 'agent_thought_chunk')
  assert.equal((conn.updates[1]!.update as any).sessionUpdate, 'agent_message_chunk')
  assert.equal(messageIdAt(conn, 0), messageIdAt(conn, 1))
})

test('PiAcpSession: chunks without a started message carry no messageId', async () => {
  const { conn, proc } = newSession()

  // No `message_start`: emitting an explicit `messageId: undefined` would change
  // the serialized notification, so the field must be omitted entirely.
  proc.emit(textDelta('orphan'))

  await flush()

  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'orphan' }
  })
})

test('PiAcpSession: adapter notices are not stamped with a messageId', async () => {
  const { conn, proc } = newSession()

  proc.emit(assistantStart)
  proc.emit(textDelta('answer'))
  // Adapter-authored notice: must never merge into the model's message.
  proc.emit({ type: 'auto_compaction_start' })

  await flush()

  assert.ok(messageIdAt(conn, 0), 'model output should be stamped')
  assert.equal(messageIdAt(conn, 1), undefined, 'adapter notice should not be stamped')
})

test('PiAcpSession: message_end of another role closes the open assistant message', async () => {
  const { conn, proc } = newSession()

  proc.emit(assistantStart)
  proc.emit(textDelta('before'))
  // pi never nests messages, so any message ending means the assistant's is over.
  proc.emit({ type: 'message_end', message: { role: 'toolResult' } })
  proc.emit(textDelta('after'))

  await flush()

  assert.ok(messageIdAt(conn, 0), 'text inside the message should be stamped')
  assert.equal(messageIdAt(conn, 1), undefined, 'text after the close must not reuse the id')
})

test('PiAcpSession: an adapter notice ends the message it interrupts', async () => {
  const { conn, proc } = newSession()

  proc.emit(assistantStart)
  proc.emit(textDelta('before'))
  // A retry notice cuts into the message; pi may keep streaming the same
  // message afterwards, but the notice already sits between the two halves.
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })
  proc.emit(textDelta('after'))

  await flush()

  const before = messageIdAt(conn, 0)
  assert.ok(before)
  assert.equal(messageIdAt(conn, 1), undefined, 'the notice itself must not be stamped')
  // Grouping across the notice would let a client place the tail in front of it.
  assert.notEqual(messageIdAt(conn, 2), before, 'text after a notice must start a new message')
})

test('PiAcpSession: messageIds are namespaced by session', async () => {
  const a = newSession('session-a')
  const b = newSession('session-b')

  a.proc.emit(assistantStart)
  a.proc.emit(textDelta('x'))
  b.proc.emit(assistantStart)
  b.proc.emit(textDelta('y'))

  await flush()

  // Counters restart per session, so ids must be namespaced to stay distinct
  // for clients that share one transcript across sessions.
  assert.notEqual(messageIdAt(a.conn, 0), messageIdAt(b.conn, 0))
})

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /export groups its own chunks but not successive exports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-export-'))
  const sessionFile = join(dir, 'session.jsonl')
  writeFileSync(sessionFile, '{"role":"user"}\n')

  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ sessionFile, messageCount: 1 })
  proc.exportHtml = async (outputPath: string) => ({ path: outputPath })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({
    sessionId: 's1',
    cwd: dir,
    proc,
    fileCommands: []
  }) as any

  await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/export' }] } as any)
  await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/export' }] } as any)

  const ids = conn.updates
    .filter(u => (u as any).update?.sessionUpdate === 'agent_message_chunk')
    .map(u => (u as any).update.messageId)

  // Each export emits a text prefix plus a resource link that belong together.
  assert.equal(ids.length, 4)
  assert.ok(ids[0], 'export chunks must be stamped so clients join them')
  assert.equal(ids[1], ids[0])
  assert.equal(ids[3], ids[2])

  // A session-derived id would repeat here, appending the second export to the
  // first export's message instead of starting a new one.
  assert.notEqual(ids[2], ids[0])
})
