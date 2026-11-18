import assert from 'node:assert/strict'
import { mkdir, mkdtemp, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { createPanel, apply } from '../index.mjs'
import { buildSession, persistConversation } from '../session.mjs'

const when = '2026-11-17T04:14:12.000Z'
const user = (id, parent_id, content) => ({ id, parent_id, role: 'USER', inserted_at: when, fragments: [{ type: 'REQUEST', content }] })
const reply = (id, parent_id, content, status = 'FINISHED') => ({
  id, parent_id, role: 'ASSISTANT', status, inserted_at: when,
  fragments: [{ type: 'THINK', content: '示例思考' }, { type: 'RESPONSE', content }],
})
const session = { id: 'abc', title: '原会话', current_message_id: 8, inserted_at: when, messages: [
  user(1, null, '暗号是蓝鲸729'), reply(2, 1, '收到'), reply(3, 1, '其他分支'),
  user(4, 2, '不会保留的轮次'), reply(5, 4, '撤回', 'CONTENT_FILTER'),
  user(6, 5, '要继续的问答'), reply(8, 6, '好的，接着聊'), reply(9, 6, '更新但没选中的分支'),
] }

function zip(entries) {
  const payload = [], directory = []
  let position = 0
  for (const [filename, value, method] of entries) {
    const name = Buffer.from(filename)
    const clear = Buffer.from(JSON.stringify(value))
    const packed = method === 8 ? deflateRawSync(clear) : clear
    const local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(clear.length, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10)
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(clear.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(position, 42)
    payload.push(local, name, packed); directory.push(central, name)
    position += local.length + name.length + packed.length
  }
  const cd = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(position, 16)
  return Buffer.concat([...payload, cd, end])
}

const logs = new Map()
const attached = new Set()
const workspace = { id: 'personal', path: '/root/workspace', attachSession: async id => { assert.ok(logs.has(id)); attached.add(id) } }
const context = {
  workspaceRegistry: { list: () => [workspace] },
  sessionPersistence: {
    stat: async id => logs.get(id),
    create: async header => {
      assert.ok(!logs.has(header.id))
      return {
        append: async events => { logs.set(header.id, { header, events: structuredClone(events) }) },
        flush: async () => assert.ok(logs.has(header.id)),
        close: async () => {},
      }
    },
  },
}
const version = 4
const api = {
  SESSION_FORMAT_VERSION: version, SessionId: value => value, SessionLogOffset: value => value,
  Session: { create(id, events, header) {
    assert.equal(header.id, id)
    assert.equal(header.version, version)
    let turn = 0, step = false, time = 0
    for (const [position, event] of events.entries()) {
      assert.equal(event.seq, position)
      assert.ok(event.time >= time)
      time = event.time
      if (event.type === 'turn/start') assert.equal(event.data.turn, ++turn)
      if (event.type === 'step/start') { assert.ok(!step); step = true }
      if (event.surfaceOp) assert.ok(step)
      if (event.type === 'step/end') { assert.ok(step); step = false }
      if (event.type === 'turn/end') assert.ok(!step)
    }
    assert.equal(events[2].data.message.role, 'system')
  } },
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-import-fixture-'))
try {
  const index = [{ id: 'abc', title: session.title, updated_at: when }]
  const entries = [['chat_session_index.json', index, 8], ['chat_sessions/abc.json', session, 8]]
  const qqFolder = join(directory, 'QQ', '文件传输助手')
  await mkdir(qqFolder, { recursive: true })
  await writeFile(join(qqFolder, 'deepseek_data-2026-11-17.zip'), zip(entries))
  await writeFile(join(directory, 'DSH-Go-Offline.zip'), Buffer.from('not a chat archive'))
  let registered
  apply({ inject: (_services, callback) => callback({ dshGo: { panel: (id, panel) => { registered = { id, panel } } } }) })
  assert.equal(registered.id, 'history')

  const panel = createPanel(context, { downloadDir: directory, getSession: () => api })
  const signal = new AbortController().signal
  const scan = await panel.actions.scan().result(signal)
  assert.equal(scan.patch.rows.length, 1)
  assert.equal(scan.patch.rows[0].subtitle, '下载/QQ/文件传输助手')
  const selected = await panel.actions.archive({}, { value: scan.patch.rows[0].action.args }).result(signal)
  assert.equal(selected.patch.rows[0].title, '原会话')
  const clicked = { value: selected.patch.rows[0].action.args }
  const imported = await panel.actions.import({}, clicked).result(signal)
  assert.match(imported.toast, /4 条消息/)
  const persisted = [...logs.values()][0]
  const visible = persisted.events.filter(event => ['user/message', 'assistant/message'].includes(event.type))
  assert.deepEqual(visible.map(event => (event.data.message ?? event.data).content.filter(x => x.type === 'text').map(x => x.text).join('')),
    ['暗号是蓝鲸729', '收到', '要继续的问答', '好的，接着聊'])
  assert.equal(visible[1].data.message.content[0].type, 'reasoning')
  assert.equal(attached.size, 1)
  const duplicate = await panel.actions.import({}, { value: imported.patch.rows[0].action.args }).result(signal)
  assert.match(duplicate.toast, /已导入过/)
  assert.equal(logs.size, 1)

  const otherWorkspace = {
    id: 'second', title: '第二工作区', path: '/root/second',
    attachSession: async id => { assert.equal(logs.get(id).header.cwd, '/root/second'); attached.add(id) },
  }
  context.workspaceRegistry.list = () => [workspace, otherWorkspace]
  const decision = await panel.actions.import({}, { value: duplicate.patch.rows[0].action.args }).result(signal)
  assert.equal(decision.patch.rows.length, 2)
  assert.equal(decision.patch.rows[1].title, '第二工作区')
  assert.equal(logs.size, 1)
  const second = await panel.actions.workspace({}, { value: decision.patch.rows[1].action.args }).result(signal)
  assert.match(second.patch.message, /第二工作区/u)
  assert.equal(logs.size, 2)
  const scopedId = [...logs.entries()].find(([, log]) => log.header.cwd === otherWorkspace.path)[0]
  const scoped = await panel.actions.import({ sessionId: scopedId }, { value: second.patch.rows[0].action.args }).result(signal)
  assert.match(scoped.toast, /已导入过/u)
  assert.equal(logs.size, 2)

  const defaultWorkspaceDir = join(directory, 'import-workspace')
  let createdWorkspace
  context.workspaceRegistry.list = () => createdWorkspace ? [createdWorkspace] : []
  context.workspaceRegistry.create = async (path, title) => {
    assert.equal(path, defaultWorkspaceDir)
    assert.equal(title, 'DeepSeek 旧聊天')
    assert.ok((await stat(path)).isDirectory())
    createdWorkspace = { id: 'created', title, path, attachSession: async id => { attached.add(id) } }
    return createdWorkspace
  }
  const emptyPanel = createPanel(context, { downloadDir: directory, getSession: () => api, defaultWorkspaceDir })
  const emptyScan = await emptyPanel.actions.scan().result(signal)
  const emptySource = await emptyPanel.actions.archive({}, { value: emptyScan.patch.rows[0].action.args }).result(signal)
  const empty = await emptyPanel.actions.import({}, { value: emptySource.patch.rows[0].action.args }).result(signal)
  assert.ok(empty.patch.buttons.some(button => button.action === 'create-workspace'))
  assert.equal(createdWorkspace, undefined)
  const created = await emptyPanel.actions['create-workspace']().result(signal)
  assert.match(created.patch.message, /DeepSeek 旧聊天/u)
  assert.equal(logs.size, 3)

  const abort = new AbortController()
  abort.abort()
  await assert.rejects(persistConversation(context, api, workspace, { ...session, id: 'other' }, '', abort.signal), /aborted/i)
  assert.equal(logs.size, 3)
  assert.throws(() => buildSession({ ...session, current_message_id: 22, messages: [user(22, 22, 'bad')] }), /顺序/)
  console.log('PASS: archive, native messages, scoped and explicit workspace selection, first workspace, duplicates and cancellation.')
} finally {
  await rm(directory, { force: true, recursive: true })
}

