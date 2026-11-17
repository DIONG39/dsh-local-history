import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listArchives, readArchive } from './archive.mjs'
import { persistConversation } from './session.mjs'

const PANEL = 'history'
const PAGE_SIZE = 25
const DOWNLOADS = '/sdcard/Download'

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
  let screen = display('点击「扫描手机下载」，选择 DeepSeek 原始导出 ZIP。旧问答会写入一条普通工作会话。')
  let archives = []
  let conversations = []
  let archive = null
  let page = 0
  let generation = 0
  let working = false
  let destination = null

  function result(data, toast) {
    screen = data
    return toast ? { patch: data, toast } : { patch: data }
  }

  function rowsForArchive() {
    const from = page * PAGE_SIZE
    const to = Math.min(from + PAGE_SIZE, conversations.length)
    const buttons = [{ label: '重新扫描', action: 'scan', icon: 'search' }]
    if (page > 0) buttons.push({ label: '上一页', action: 'previous' })
    if (to < conversations.length) buttons.push({ label: '下一页', action: 'next' })
    return {
      tone: 'info', buttons,
      message: `点一段旧聊天即可导入。当前第 ${from + 1}–${to} 段，共 ${conversations.length} 段。`,
      rows: conversations.slice(from, to).map((row, offset) => ({
        title: row.title.slice(0, 100),
        subtitle: row.at ? new Date(row.at).toISOString().slice(0, 10) : 'DeepSeek 对话',
        action: { id: 'import', args: { index: from + offset, generation } },
      })),
    }
  }

  function rowsForWorkspaces() {
    const { row, workspaces, page: workspacePage } = destination
    const buttons = [{ label: '返回聊天列表', action: 'back' }]
    const from = workspacePage * PAGE_SIZE
    if (workspacePage > 0) buttons.push({ label: '上一页', action: 'workspace-previous' })
    if (from + PAGE_SIZE < workspaces.length) buttons.push({ label: '下一页', action: 'workspace-next' })
    if (!workspaces.length) buttons.push({ label: '创建导入工作区', action: 'create-workspace', style: 'primary' })
    return {
      buttons, tone: 'info',
      message: workspaces.length
        ? `选择把「${row.title.slice(0, 90)}」导入到哪个工作区。`
        : '本机还没有工作区。点「创建导入工作区」，会新建「DeepSeek 旧聊天」并导入刚选中的对话。',
      rows: workspaces.slice(from, from + PAGE_SIZE).map(workspace => ({
        title: (workspace.title || workspace.path).slice(0, 100),
        subtitle: workspace.path.slice(0, 120),
        action: { id: 'workspace', args: { id: workspace.id, generation } },
      })),
    }
  }

  async function importInto(row, workspace, signal) {
    const session = await readArchive(archive, row)
    const api = await getSession()
    const imported = await persistConversation(ctx, api, workspace, session, row.title, signal)
    const summary = imported.duplicate ? '这段聊天已导入过。' : `已导入 ${imported.messages} 条消息。`
    destination = null
    generation++
    return result({
      ...rowsForArchive(), tone: 'good',
      message: `${summary}回到会话列表，在「${(workspace.title || workspace.path).slice(0, 80)}」打开「${imported.title}」。旧聊天的时间会保留。`,
    }, summary)
  }

  function pending(label, operation) {
    if (working) return { toast: '请等当前操作完成。' }
    working = true
    return {
      pending: { label, timeoutMs: 60000 },
      result: async signal => {
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
    view: VIEW,
    data: (_scope, emit) => { emit(screen) },
    actions: {
      scan: () => pending('正在扫描下载', async signal => {
        const found = await listArchives(downloadDir)
        signal?.throwIfAborted()
        archives = found
        conversations = []
        archive = null
        destination = null
        generation++
        if (!archives.length) return result(display('在「下载」及其子文件夹里没有找到 DeepSeek 原始 ZIP。请保存原始导出包，文件名以 deepseek_data 或 deepseek-data 开头。', 'warn'))
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
        archive = selected
        conversations = rows
        destination = null
        page = 0
        generation++
        return result(rowsForArchive())
      }),
      next: () => {
        if (working || destination) return undefined
        if ((page + 1) * PAGE_SIZE < conversations.length) page++
        return archive ? result(rowsForArchive()) : undefined
      },
      previous: () => {
        if (working || destination) return undefined
        if (page > 0) page--
        return archive ? result(rowsForArchive()) : undefined
      },
      import: (scope, event) => pending('正在准备导入', async signal => {
        const row = conversations[event.value?.index]
        if (!row || !archive || event.value?.generation !== generation) throw new Error('列表已更新，请重新选择聊天。')
        const workspaces = ctx.workspaceRegistry.list()
        const workspace = await selectedWorkspace(ctx, scope?.sessionId, workspaces)
        signal?.throwIfAborted()
        if (workspace) return importInto(row, workspace, signal)
        destination = { row, workspaces, page: 0 }
        generation++
        return result(rowsForWorkspaces())
      }),
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
        return importInto(destination.row, workspace, signal)
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
        return importInto(destination.row, workspace, signal)
      }),
    },
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo', 'sessionPersistence', 'workspaceRegistry'], inner => {
    inner.dshGo.panel(PANEL, createPanel(inner))
  })
}
