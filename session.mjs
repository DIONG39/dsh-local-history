import { createHash, randomUUID } from 'node:crypto'

function activeBranch(session) {
  if (!Array.isArray(session?.messages)) throw new Error('这段对话无法读取。')
  const bag = new Map()
  let latest = null
  for (const message of session.messages) {
    if (!Number.isSafeInteger(message?.id) || bag.has(message.id)) throw new Error('导出包内的消息编号有误。')
    bag.set(message.id, message)
    if (!latest || message.id > latest.id) latest = message
  }
  const branch = []
  const visited = new Set()
  for (let message = bag.get(session.current_message_id) ?? latest; message; message = bag.get(message.parent_id)) {
    if (visited.has(message.id) || (message.parent_id != null && !bag.has(message.parent_id))) {
      throw new Error('这段对话的消息顺序有误。')
    }
    visited.add(message.id)
    branch.push(message)
  }
  return branch.reverse()
}

function shortTitle(value) {
  const title = String(value || '导入的 DeepSeek 对话').replace(/\s+/gu, ' ').trim() || '导入的 DeepSeek 对话'
  let output = ''
  for (const character of title) {
    if (Buffer.byteLength(output + character) > 80) break
    output += character
  }
  return output
}

function fragments(message) {
  return Array.isArray(message?.fragments) ? message.fragments : []
}

function questionContent(message) {
  const parts = []
  for (const fragment of fragments(message)) {
    if (fragment?.type === 'REQUEST' && typeof fragment.content === 'string') parts.push(fragment.content)
    if (fragment?.type === 'FILE' && Array.isArray(fragment.files)) {
      for (const file of fragment.files) {
        if (typeof file?.file_name === 'string') parts.push(`〔原附件：${file.file_name}〕`)
      }
    }
  }
  return parts.join('\n')
}

function responseContent(reply) {
  if (reply?.status !== 'FINISHED') return []
  const parts = fragments(reply)
  if (parts.some(fragment => fragment?.type === 'TEMPLATE_RESPONSE')) return []
  const content = []
  for (const fragment of parts) {
    if (typeof fragment?.content !== 'string' || !fragment.content) continue
    if (fragment.type === 'RESPONSE') content.push({ type: 'text', text: fragment.content })
    if (fragment.type === 'THINK') content.push({ type: 'reasoning', text: fragment.content })
  }
  return content.some(part => part.type === 'text' && part.text.trim()) ? content : []
}

export function buildSession(session, fallbackTitle, newId = randomUUID) {
  const branch = activeBranch(session)
  const title = shortTitle(session.title || fallbackTitle)
  const events = []
  const add = (type, data, surfaceOp) => {
    events.push({ type, data, seq: events.length, time, ...(surfaceOp ? { surfaceOp } : {}) })
  }
  let time = Date.parse(session.inserted_at) || 0
  let turn = 0
  let messages = 0
  for (let index = 0; index < branch.length; index++) {
    const user = branch[index]
    if (user.role !== 'USER') continue
    const next = branch[index + 1]
    const reply = next?.role === 'ASSISTANT' ? next : null
    if (reply) index++
    const question = questionContent(user)
    if (!question.trim() || reply?.status === 'CONTENT_FILTER') continue
    turn++
    const step = 1
    time = Math.max(time, Date.parse(user.inserted_at) || time)
    add('turn/start', { turn })
    add('step/start', { turn, step })
    if (turn === 1) {
      const message = { id: newId(), role: 'system', content: [], source: { kind: 'system-prompt' } }
      add('system/message', { turn, step, message }, 'append')
    }
    add('user/message', { id: newId(), role: 'user', content: [{ type: 'text', text: question }], source: { kind: 'user' } }, 'append')
    messages++
    const content = responseContent(reply)
    if (content.length) {
      time = Math.max(time, Date.parse(reply.inserted_at) || time)
      const message = {
        id: newId(), role: 'assistant', content,
        source: { kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' },
      }
      add('assistant/message', { turn, step, message, stream: [] }, 'append')
      messages++
    }
    add('step/end', { turn, step })
    const reason = content.length ? { kind: 'completed' } : {
      kind: 'error', error: { code: 'DEEPSEEK_EXPORT_NO_REPLY', message: '原导出里没有可导入的完整回复。' },
    }
    add('turn/end', { turn, reason })
    if (turn === 1) add('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
  }
  if (!messages) throw new Error('这一分支没有可导入的正常问答。')
  return { title, events, messages, createdAt: events[0].time }
}

function stableId(workspaceId, conversationId, currentMessageId) {
  const hash = createHash('sha256').update(JSON.stringify(['deepseek-web-import-v1', workspaceId, conversationId, currentMessageId])).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export async function persistConversation(ctx, api, workspace, session, fallbackTitle, signal) {
  const id = api.SessionId(stableId(workspace.id, session.id, session.current_message_id))
  const present = await ctx.sessionPersistence.stat(id)
  if (present) {
    if (present.header.cwd !== workspace.path) throw new Error('已登记的会话工作区与本次不一致。')
    await workspace.attachSession(id)
    return { duplicate: true, title: shortTitle(session.title || fallbackTitle) }
  }
  const history = buildSession(session, fallbackTitle)
  const header = { version: api.SESSION_FORMAT_VERSION, id, createdAt: history.createdAt, cwd: workspace.path, isSeeded: false }
  api.Session.create(id, history.events, header)
  signal?.throwIfAborted()
  const handle = await ctx.sessionPersistence.create(header, { signal })
  try {
    await handle.append(history.events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  try {
    ctx.get?.('sessionProjectionCache')?.coldSnapshot(header, api.SessionLogOffset(0), history.events)
  } catch {
    // The UI can derive its title from the durable session log on a cold read.
  }
  await workspace.attachSession(id)
  return history
}
