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
let interruptAfter

function writer(id) {
  const log = logs.get(id)
  return {
    read: async (offset, limit) => ({ events: structuredClone(log.events.slice(offset, offset + limit)) }),
    append: async events => {
      assert.equal(events[0].seq, log.events.length)
      if (interruptAfter !== undefined) {
        log.events.push(...structuredClone(events.slice(0, interruptAfter)))
        interruptAfter = undefined
        throw new Error('模拟写入中断')
      }
      log.events.push(...structuredClone(events))
    },
    flush: async () => assert.ok(logs.has(id)),
    close: async () => {},
  }
}

const workspace = { id: 'personal', path: '/root/workspace', attachSession: async id => { assert.ok(logs.has(id)); attached.add(id) } }
const context = {
  workspaceRegistry: { list: () => [workspace] },
  sessionPersistence: {
    stat: async id => logs.get(id),
    create: async header => {
      assert.ok(!logs.has(header.id))
      logs.set(header.id, { header, events: [] })
      return writer(header.id)
    },
    open: async id => writer(id),
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
  const exportZip = zip(entries)
  const unrelatedZip = zip([['other.json', {}, 0]])
  const qqFolder = join(directory, 'QQ', '文件传输助手')
  await mkdir(qqFolder, { recursive: true })
  await writeFile(join(qqFolder, 'deepseek_data-2026-11-17.zip'), exportZip)
  await writeFile(join(directory, '我的聊天备份.ZIP'), exportZip)
  await writeFile(join(directory, 'large-archive.zip'), zip([...entries, ['extra.json', 'a'.repeat(8 * 1024 * 1024), 0]]))
  await writeFile(join(directory, 'DSH-Go-Offline.zip'), unrelatedZip)
  await writeFile(join(directory, '未下载完成.zip'), Buffer.from('incomplete'))
  let registered
  apply({ inject: (_services, callback) => callback({ dshGo: { panel: (id, panel) => { registered = { id, panel } } } }) })
  assert.equal(registered.id, 'history')

  const panel = createPanel(context, { downloadDir: directory, getSession: () => api })
  const signal = new AbortController().signal
  const scan = await panel.actions.scan().result(signal)
  assert.deepEqual(scan.patch.rows.map(row => row.title).sort(),
    ['deepseek_data-2026-11-17.zip', 'large-archive.zip', '我的聊天备份.ZIP'])
  const originalExport = scan.patch.rows.find(row => row.subtitle === '下载/QQ/文件传输助手')
  assert.equal(originalExport.title, 'deepseek_data-2026-11-17.zip')
  const large = scan.patch.rows.find(row => row.title === 'large-archive.zip')
  const selected = await panel.actions.archive({}, { value: large.action.args }).result(signal)
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

  const picker = createPanel({
    ...context, dshGo: { readPickedFile: handle => ({ export: exportZip, unrelated: unrelatedZip })[handle] },
  }, { downloadDir: directory, getSession: () => api })
  const choose = () => picker.actions['choose-zip']()
  const onPicked = value => picker.actions['zip-picked']({}, { value, signal })
  assert.ok(picker.view({}, { features: ['files'] }).children.some(child =>
    Array.isArray(child.items) && child.items.some(item => item.action === 'choose-zip')))
  assert.ok(picker.view({}, { features: [] }).children.every(child => child.items?.[0]?.action !== 'choose-zip'))
  assert.deepEqual(choose(), { type: 'pickFile', action: 'zip-picked', maxFiles: 1 })
  assert.match((await onPicked({ status: 'error', files: [] })).patch.message, /8 MB/)
  choose()
  assert.match((await onPicked({
    status: 'selected', files: [{ handle: 'export', bytes: 8 * 1024 * 1024 + 1 }],
  })).patch.message, /8 MB/)
  choose()
  const pickedExport = await onPicked({
    status: 'selected', files: [{ handle: 'export', name: '浏览器改过的名字.ZIP', bytes: exportZip.length }],
  })
  assert.equal(pickedExport.patch.rows[0].title, session.title)
  choose()
  assert.equal(await onPicked({ status: 'cancelled', files: [] }), undefined)
  choose()
  const invalid = await onPicked({
    status: 'selected', files: [{ handle: 'unrelated', name: 'other.zip', bytes: unrelatedZip.length }],
  })
  assert.match(invalid.patch.message, /原始 ZIP/)
  const pickedImport = await picker.actions.import({}, { value: pickedExport.patch.rows[0].action.args }).result(signal)
  assert.match(pickedImport.toast, /已导入过/)
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

  const renamed = { ...session, title: '在 DeepSeek 改过的标题' }
  assert.deepEqual(await persistConversation(context, api, workspace, renamed, '', signal), {
    duplicate: true, title: session.title,
  })
  const changed = { ...renamed, messages: renamed.messages.map(message =>
    message.id === 6 ? user(6, 5, '实际改过的消息') : message) }
  await assert.rejects(persistConversation(context, api, workspace, changed, '', signal), {
    code: 'DSH_IMPORT_CONTENT_MISMATCH',
  })
  assert.equal(logs.size, 3)

  for (const kept of [0, 5, 9]) {
    const recovering = { ...session, id: 'interrupted-' + kept }
    const before = new Set(logs.keys())
    interruptAfter = kept
    await assert.rejects(persistConversation(context, api, workspace, recovering, '', signal), /模拟写入中断/)
    const [id, log] = [...logs.entries()].find(([id]) => !before.has(id))
    const prefix = structuredClone(log.events)
    assert.equal(prefix.length, kept)
    assert.ok(!attached.has(id))
    const source = kept === 9 ? { ...recovering, title: renamed.title } : recovering
    const resumed = await persistConversation(context, api, workspace, source, '', signal)
    assert.equal(resumed.messages, 4)
    assert.equal(resumed.title, session.title)
    assert.deepEqual(log.events.slice(0, kept), prefix)
    assert.equal(log.events.length, resumed.events.length)
    assert.ok(attached.has(id))
    log.events.push({ type: 'continued-after-import', seq: log.events.length })
    const retried = await persistConversation(context, api, workspace, recovering, '', signal)
    assert.equal(retried.duplicate, true)
    assert.equal(log.events.at(-1).type, 'continued-after-import')
  }

  const batchRows = [
    session,
    ...Array.from({ length: 26 }, (_, i) => ({ ...session, id: 'batch-' + i, title: '批量对话 ' + i })),
    { ...session, id: 'broken', title: '损坏的对话' },
  ]
  const batchZip = zip([
    ['chat_session_index.json', batchRows.map(row => ({ id: row.id, title: row.title, updated_at: when })), 8],
    ...batchRows.map(row => ['chat_sessions/' + row.id + '.json', row.id === 'broken' ? { ...row, id: 'wrong' } : row, 8]),
  ])
  function waitForBatch(panel) {
    const { promise, resolve } = Promise.withResolvers()
    const unsubscribe = panel.data({}, data => {
      if (/成功 \d+ 段/.test(data.message)) resolve(data)
    })
    return promise.finally(unsubscribe)
  }

  function prepareBatch() {
    const batchPanel = createPanel({ ...context, dshGo: { readPickedFile: () => batchZip } }, { getSession: () => api })
    batchPanel.actions['choose-zip']()
    const list = batchPanel.actions['zip-picked']({}, {
      signal, value: { status: 'selected', files: [{ handle: 'batch', bytes: batchZip.length }] },
    })
    return { batchPanel, list }
  }

  context.workspaceRegistry.list = () => [workspace, otherWorkspace]
  const bulk = prepareBatch()
  assert.equal((await bulk.list).patch.rows.length, 25)
  const chooseWorkspace = await bulk.batchPanel.actions['import-all']({}).result(signal)
  assert.match(chooseWorkspace.patch.message, /全部 28 段/)
  assert.ok(chooseWorkspace.patch.rows.some(row => row.title === '第二工作区'))
  const firstWorkspace = chooseWorkspace.patch.rows[0]
  const bulkResult = waitForBatch(bulk.batchPanel)
  const workingBatch = await bulk.batchPanel.actions.workspace({}, { value: firstWorkspace.action.args }).result(signal)
  assert.equal(workingBatch.patch.buttons[0].action, 'stop-import')
  const completedBatch = await bulkResult
  assert.match(completedBatch.message, /成功 26 段，已导入过 1 段，失败 1 段/)
  assert.equal(bulk.batchPanel.actions.next().patch.rows.find(row => row.title === '损坏的对话').trailing, '导入失败')

  let stoppingPanel
  let stopAfterFirst = true
  const stoppingWorkspace = {
    id: 'stopping',
    path: '/root/stopping',
    attachSession: async () => {
      if (stopAfterFirst) stoppingPanel.actions['stop-import']()
    },
  }
  context.workspaceRegistry.list = () => [stoppingWorkspace]
  const stopping = prepareBatch()
  stoppingPanel = stopping.batchPanel
  await stopping.list
  const stoppedResult = waitForBatch(stoppingPanel)
  await stoppingPanel.actions['import-all']({}).result(signal)
  const stopped = await stoppedResult
  assert.match(stopped.message, /已停止。成功 1 段，已导入过 0 段，失败 0 段。未处理 27 段/)
  stopAfterFirst = false
  const restarted = await stoppingPanel.actions['import-all']({}).result(signal)
  assert.equal(restarted.patch.buttons[0].action, 'stop-import')
  const resumedBatch = await waitForBatch(stoppingPanel)
  assert.match(resumedBatch.message, /成功 26 段，已导入过 1 段，失败 1 段/)

  const longRows = Array.from({ length: 30 }, (_, i) => ({
    ...session,
    id: 'length-' + i,
    title: i + '旧'.repeat(54) + '\u0000'.repeat(40) + '末',
  }))
  const longZip = zip([
    ['chat_session_index.json', longRows.map(row => ({ id: row.id, title: row.title, updated_at: when })), 8],
    ...longRows.map(row => ['chat_sessions/' + row.id + '.json', row, 8]),
  ])
  let fail = true
  const longPanel = createPanel({
    ...context,
    dshGo: { readPickedFile: () => longZip },
    workspaceRegistry: { list: () => [workspace] },
    sessionPersistence: {
      ...context.sessionPersistence,
      stat: async id => {
        if (fail) throw new Error('模拟长错误详情'.repeat(100))
        return context.sessionPersistence.stat(id)
      },
    },
  }, { getSession: () => api })
  longPanel.actions['choose-zip']()
  await longPanel.actions['zip-picked']({}, {
    signal, value: { status: 'selected', files: [{ handle: 'long', bytes: longZip.length }] },
  })
  const longResult = waitForBatch(longPanel)
  await longPanel.actions['import-all']({}).result(signal)
  const failedPage = await longResult
  assert.match(failedPage.message, /失败 30 段/)
  assert.ok(failedPage.rows.length < 25)
  assert.ok(failedPage.rows.every(row => row.subtitle === '点此重试并查看原因'))
  const secondPage = longPanel.actions.next().patch
  const previousPage = longPanel.actions.previous().patch
  for (const screen of [failedPage, secondPage, previousPage]) {
    assert.ok(Buffer.byteLength(JSON.stringify(screen)) <= 16 * 1024)
  }
  assert.deepEqual(previousPage.rows, failedPage.rows)
  assert.deepEqual(
    [...failedPage.rows, ...secondPage.rows].map(row => row.action.args.index),
    longRows.map((_, index) => index),
  )
  fail = false
  const retryRow = longPanel.actions.next().patch.rows[0].action.args
  const retriedRow = await longPanel.actions.import({}, { value: retryRow }).result(signal)
  assert.match(retriedRow.toast, /已导入 4 条消息/)
  console.log('PASS: scanning, file selection, rename-safe deduplication, interrupted imports, batch failure pagination, and single retries.')
} finally {
  await rm(directory, { force: true, recursive: true })
}

