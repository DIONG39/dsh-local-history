import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { listArchives, readArchive, withArchive } from './archive.mjs'
import { persistConversation } from './session.mjs'

const PANEL = 'history'
const PAGE_SIZE = 25
// DSH Go limits merge patches to 16 KiB. Leave room for status, buttons, and the envelope.
const ARCHIVE_ROWS_BUDGET = 12 * 1024
const DOWNLOADS = '/sdcard/Download'
const MAX_PICKED_ZIP = 8 * 1024 * 1024
const BATCH_FAILURE_LABEL = new Map([
  ['DSH_IMPORT_ENTRY_TOO_LARGE', '这段聊天太大'],
  ['DSH_IMPORT_CONTENT_MISMATCH', '已有消息与导出内容不一致'],
])

const VIEW = {
  v: 1,
  type: 'stack',
  title: '导入旧聊天',
  children: [
    { type: 'callout', text: { $: 'data.message' }, tone: { $: 'data.tone' } },
    { type: 'actions', items: { $: 'data.buttons' } },
    { type: 'list', items: { $: 'data.rows' } },
  ],
}

const PICKER_VIEW = {
  ...VIEW,
  children: [
    { type: 'actions', items: [{ label: '选择 ZIP 文件', action: 'choose-zip', style: 'primary' }] },
    ...VIEW.children,
  ],
}

function readEngineSession() {
  // Use the module the local Android engine already loads, without installing dependencies.
  const require = createRequire('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json')
  return import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
}

async function selectedWorkspace(ctx, sessionId, workspaces) {
  if (workspaces.length === 1) return workspaces[0]
  if (!sessionId || !workspaces.length) return undefined
  try {
    const active = await ctx.sessionPersistence.stat(sessionId)
    return workspaces.find(workspace => workspace.path === active?.header.cwd)
  } catch {
    // A missing or unavailable session should still allow choosing a workspace.
    return undefined
  }
}

function display(text, tone = 'info') {
  return { message: text, tone, rows: [], buttons: [{ label: '扫描手机下载', action: 'scan', icon: 'search' }] }
}

export function createPanel(ctx, {
  downloadDir = DOWNLOADS,
  getSession = readEngineSession,
  defaultWorkspaceDir = join(homedir(), 'DeepSeek-旧聊天'),
} = {}) {
  let screen = display('请先从 DeepSeek 导出聊天。扫描会在手机「下载」里找原始 ZIP。')
  let archives = []
  let conversations = []
  let archive = null
  let page = 0
  let archivePageStarts = [0]
  let generation = 0
  let working = false
  let destination = null
  let pickGeneration
  let batch = null
  const failedRows = new Map()
  const listeners = new Set()
  ctx.effect?.(() => () => {
    batch?.controller.abort()
    listeners.clear()
  })

  function result(data, toast) {
    screen = data
    return toast ? { patch: data, toast } : { patch: data }
  }

  function publish(data) {
    screen = data
    for (const emit of listeners) emit(screen)
  }

  function archiveRow(index, rowGeneration = generation) {
    const row = conversations[index]
    const failure = failedRows.get(row)
    return {
      title: row.title.slice(0, 100),
      subtitle: failure ?? (row.at ? new Date(row.at).toISOString().slice(0, 10) : 'DeepSeek 对话'),
      ...(failure ? { trailing: '导入失败', tone: 'bad' } : {}),
      action: { id: 'import', args: { index, generation: rowGeneration } },
    }
  }

  function updateArchivePages(anchor = archivePageStarts[page] ?? 0) {
    const starts = [0]
    let bytes = 2 // Array brackets; count one comma per row as a conservative bound.
    for (let index = 0; index < conversations.length; index++) {
      const row = archiveRow(index, Number.MAX_SAFE_INTEGER)
      const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1
      if (index - starts.at(-1) >= PAGE_SIZE || bytes + rowBytes > ARCHIVE_ROWS_BUDGET) {
        starts.push(index)
        bytes = 2
      }
      bytes += rowBytes
    }
    archivePageStarts = starts
    page = starts.findLastIndex(start => start <= anchor)
  }

  function rowsForArchive() {
    const from = archivePageStarts[page]
    const to = archivePageStarts[page + 1] ?? conversations.length
    const buttons = [
      { label: '一键导入全部', action: 'import-all', style: 'primary' },
      { label: '重新扫描', action: 'scan', icon: 'search' },
    ]
    if (page > 0) buttons.push({ label: '上一页', action: 'previous' })
    if (to < conversations.length) buttons.push({ label: '下一页', action: 'next' })
    return {
      tone: 'info', buttons,
      message: `共 ${conversations.length} 段旧聊天。当前显示第 ${from + 1}–${to} 段。`,
      rows: Array.from({ length: to - from }, (_, offset) => archiveRow(from + offset)),
    }
  }

  function showConversations(selected, rows) {
    archive = selected
    conversations = rows
    destination = null
    failedRows.clear()
    updateArchivePages(0)
    generation++
    return result(rowsForArchive())
  }

  function rowsForWorkspaces() {
    const { row, workspaces, page: workspacePage } = destination
    const buttons = [{ label: '返回聊天列表', action: 'back' }]
    const from = workspacePage * PAGE_SIZE
    const subject = row ? `「${row.title.slice(0, 90)}」` : `全部 ${conversations.length} 段旧聊天`
    if (workspacePage > 0) buttons.push({ label: '上一页', action: 'workspace-previous' })
    if (from + PAGE_SIZE < workspaces.length) buttons.push({ label: '下一页', action: 'workspace-next' })
    if (!workspaces.length) buttons.push({ label: '创建导入工作区', action: 'create-workspace', style: 'primary' })
    return {
      buttons, tone: 'info',
      message: workspaces.length
        ? `选择把${subject}导入到哪个工作区。`
        : `点「创建导入工作区」，会新建「DeepSeek 旧聊天」并导入${subject}。`,
      rows: workspaces.slice(from, from + PAGE_SIZE).map(workspace => ({
        title: (workspace.title || workspace.path).slice(0, 100),
        subtitle: workspace.path.slice(0, 120),
        action: { id: 'workspace', args: { id: workspace.id, generation } },
      })),
    }
  }

  async function importRow(row, workspace, api, signal, read) {
    signal?.throwIfAborted()
    const session = await read(row)
    return persistConversation(ctx, api, workspace, session, row.title, signal)
  }

  async function importInto(row, workspace, signal) {
    const imported = await importRow(row, workspace, await getSession(), signal, selected => readArchive(archive, selected))
    if (failedRows.delete(row)) updateArchivePages()
    const summary = imported.duplicate ? '这段聊天已导入过。' : `已导入 ${imported.messages} 条消息。`
    destination = null
    generation++
    return result({
      ...rowsForArchive(), tone: 'good',
      message: imported.duplicate
        ? `${summary}回到会话列表，在「${(workspace.title || workspace.path).slice(0, 80)}」查看。`
        : `${summary}回到会话列表，在「${(workspace.title || workspace.path).slice(0, 80)}」打开「${imported.title}」。旧聊天的时间会保留。`,
    }, summary)
  }

  async function startBatch(workspace, signal) {
    const api = await getSession()
    signal?.throwIfAborted()
    destination = null
    failedRows.clear()
    generation++
    const controller = new AbortController()
    batch = { controller, imported: 0, skipped: 0 }
    const view = batchProgress()
    void runBatch(workspace, api)
    return result(view)
  }

  function batchProgress() {
    const done = batch.imported + batch.skipped + failedRows.size
    const stopping = batch.controller.signal.aborted
    return {
      message: stopping ? '正在停止导入，已写入的会话会保留。' : `正在导入旧聊天，已处理 ${done} / ${conversations.length} 段。`,
      tone: 'info', rows: [],
      buttons: stopping ? [] : [{ label: '停止导入', action: 'stop-import' }],
    }
  }

  async function runBatch(workspace, api) {
    const job = batch
    const { signal } = job.controller
    let nextUpdate = Date.now() + 250
    let sourceError = ''
    // Let the initial progress patch reach the app before starting the work.
    await yieldToLoop()
    try {
      if (!signal.aborted) await withArchive(archive, async read => {
        for (const row of conversations) {
          if (signal.aborted) break
          try {
            const imported = await importRow(row, workspace, api, signal, read)
            if (imported.duplicate) job.skipped++
            else job.imported++
          } catch (error) {
            if (signal.aborted) break
            failedRows.set(row, BATCH_FAILURE_LABEL.get(error?.code) ?? '点此重试并查看原因')
          }
          if (Date.now() >= nextUpdate) {
            publish(batchProgress())
            nextUpdate = Date.now() + 250
          }
          await yieldToLoop()
        }
      })
    } catch (error) {
      sourceError = error instanceof Error ? error.message.slice(0, 100) : '读取 ZIP 失败。'
    }
    const { imported, skipped } = job
    batch = null
    const failed = failedRows.size
    const remaining = conversations.length - imported - skipped - failed
    const status = sourceError ? `批量导入中断。${sourceError}` : remaining ? '已停止。' : '导入已完成。'
    const summary = `${status}成功 ${imported} 段，已导入过 ${skipped} 段，失败 ${failed} 段。${remaining ? `未处理 ${remaining} 段。` : ''}`
    const details = failed
      ? '点列表中标记「导入失败」的对话可重试。'
      : imported ? `回到会话列表，在「${(workspace.title || workspace.path).slice(0, 60)}」查看。` : ''
    updateArchivePages()
    publish({
      ...rowsForArchive(),
      tone: failed || remaining || sourceError ? 'warn' : 'good',
      message: summary + details,
    })
  }

  function importDestination(scope, row) {
    const requestedAt = generation
    return pending(row ? '正在准备导入' : '正在准备批量导入', async signal => {
      if (!archive) throw new Error('请先选一个 DeepSeek 导出 ZIP。')
      if (requestedAt !== generation) throw new Error('列表已更新，请重新选择。')
      const workspaces = ctx.workspaceRegistry.list()
      const workspace = await selectedWorkspace(ctx, scope?.sessionId, workspaces)
      signal?.throwIfAborted()
      if (workspace) return row ? importInto(row, workspace, signal) : startBatch(workspace, signal)
      destination = { row, workspaces, page: 0 }
      generation++
      return result(rowsForWorkspaces())
    })
  }

  function pending(label, operation) {
    if (working || batch) return { toast: '请等当前操作完成。' }
    return {
      pending: { label, timeoutMs: 60000 },
      result: async signal => {
        if (working || batch) return { toast: '请等当前操作完成。' }
        working = true
        try {
          return await operation(signal)
        } catch (error) {
          if (signal?.aborted) return
          const message = error instanceof Error ? error.message : '处理失败，请重新扫描。'
          return result({ ...screen, message: message.slice(0, 260), tone: 'bad' }, '操作未完成')
        } finally {
          working = false
        }
      },
    }
  }

  return {
    view: (_scope, caps) => caps?.features?.includes('files') ? PICKER_VIEW : VIEW,
    data: (_scope, emit) => {
      listeners.add(emit)
      emit(screen)
      return () => { listeners.delete(emit) }
    },
    actions: {
      'choose-zip': () => {
        if (working || batch) return { toast: '请等当前操作完成。' }
        pickGeneration = generation
        return { type: 'pickFile', action: 'zip-picked', maxFiles: 1 }
      },
      'zip-picked': async (_scope, event) => {
        const requestedAt = pickGeneration
        pickGeneration = undefined
        if (working || batch || requestedAt !== generation || event.signal?.aborted) return
        if (event.value?.status === 'cancelled') return
        const selected = event.value?.files?.[0]
        if (event.value?.status !== 'selected' || !selected || selected.bytes > MAX_PICKED_ZIP) {
          return result({
            ...screen, tone: 'warn',
            message: '选取文件失败。可再选一次。若 ZIP 超过 8 MB，请放到手机「下载」，再点扫描。',
          }, '无法读取所选文件')
        }
        working = true
        try {
          const picked = ctx.dshGo.readPickedFile(selected.handle)
          const bytes = Buffer.isBuffer(picked) ? picked : Buffer.from(picked)
          const source = { bytes }
          const rows = await readArchive(source)
          event.signal?.throwIfAborted()
          archives = []
          return showConversations(source, rows)
        } catch {
          if (event.signal?.aborted) return
          return result({
            ...screen, tone: 'warn',
            message: '无法打开这份导出。请选择从 DeepSeek 下载的原始 ZIP。如果下载未完成，请重新下载。',
          }, '无法读取 DeepSeek 导出')
        } finally {
          working = false
        }
      },
      scan: () => pending('正在扫描下载', async signal => {
        const found = await listArchives(downloadDir, signal)
        signal?.throwIfAborted()
        archives = found
        conversations = []
        archive = null
        destination = null
        failedRows.clear()
        generation++
        if (!archives.length) return result(display('手机「下载」里没有找到 DeepSeek 导出。请确认已下载原始 ZIP。保存到「下载」后可以重新扫描。', 'warn'))
        return result({
          ...display('点选要使用的 DeepSeek 导出 ZIP。'),
          rows: archives.map((file, index) => ({
            title: file.name.slice(0, 120),
            subtitle: `下载${file.relativeDirectory ? `/${file.relativeDirectory}` : ''}`.slice(0, 100),
            action: { id: 'archive', args: { index, generation } },
          })),
        })
      }),
      archive: (_scope, event) => pending('正在读取聊天列表', async signal => {
        const selected = archives[event.value?.index]
        if (!selected || event.value?.generation !== generation) throw new Error('文件列表已更新，请重新选择。')
        const rows = await readArchive(selected)
        signal?.throwIfAborted()
        return showConversations(selected, rows)
      }),
      next: () => {
        if (working || batch || destination) return undefined
        if (page + 1 < archivePageStarts.length) page++
        return archive ? result(rowsForArchive()) : undefined
      },
      previous: () => {
        if (working || batch || destination) return undefined
        if (page > 0) page--
        return archive ? result(rowsForArchive()) : undefined
      },
      import: (scope, event) => {
        const row = conversations[event.value?.index]
        if (!row || event.value?.generation !== generation) return { toast: '列表已更新，请重新选择聊天。' }
        return importDestination(scope, row)
      },
      'import-all': scope => {
        if (destination) return { toast: '请先选择工作区。' }
        return importDestination(scope, null)
      },
      'stop-import': () => {
        if (!batch) return
        batch.controller.abort()
        return result(batchProgress())
      },
      back: () => {
        if (working || !destination) return undefined
        destination = null
        generation++
        return result(rowsForArchive())
      },
      'workspace-previous': () => {
        if (working || !destination || destination.page === 0) return undefined
        destination.page--
        return result(rowsForWorkspaces())
      },
      'workspace-next': () => {
        if (working || !destination || (destination.page + 1) * PAGE_SIZE >= destination.workspaces.length) return undefined
        destination.page++
        return result(rowsForWorkspaces())
      },
      workspace: (_scope, event) => pending('正在写入旧消息', async signal => {
        if (!destination || event.value?.generation !== generation) throw new Error('工作区列表已更新，请重新选择。')
        const workspace = ctx.workspaceRegistry.list().find(item => item.id === event.value?.id)
        if (!workspace) throw new Error('这个工作区已移除，请返回后重新选择。')
        const { row } = destination
        return row ? importInto(row, workspace, signal) : startBatch(workspace, signal)
      }),
      'create-workspace': () => pending('正在创建工作区', async signal => {
        if (!destination || destination.workspaces.length) return undefined
        signal?.throwIfAborted()
        const workspaces = ctx.workspaceRegistry.list()
        if (workspaces.length) {
          destination.workspaces = workspaces
          generation++
          return result(rowsForWorkspaces())
        }
        await mkdir(defaultWorkspaceDir, { recursive: true })
        const workspace = await ctx.workspaceRegistry.create(defaultWorkspaceDir, 'DeepSeek 旧聊天')
        const { row } = destination
        return row ? importInto(row, workspace, signal) : startBatch(workspace, signal)
      }),
    },
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo', 'sessionPersistence', 'workspaceRegistry'], inner => {
    inner.dshGo.panel(PANEL, createPanel(inner))
  })
}
