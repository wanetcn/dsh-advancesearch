/**
 * dsh-advancesearch — DeepSeek Harness 高级搜索插件(Host 侧)。
 *
 * 通过 `sessionQuery` 服务提供已认证搜索路由:
 *   GET /api/dsh-advancesearch?q=关键字[&limit=20]
 *       → 搜索所有会话(标题 + 内容),返回会话命中与片段
 *   GET /api/dsh-advancesearch?q=关键字&sessionId=<id>[&limit=20]
 *       → 在单个会话内搜索,返回逐条片段
 *
 * 优先使用后端全文索引(searchSessions/searchEvents);当部署把索引配置为
 * openAt "never"(桌面组合默认如此)时,自动回退到官方语义扫描接口
 * listSessions + filterEvents(字面、大小写不敏感、空白灵活匹配)。
 *
 * 另支持搜索本机外部 coding agent 的会话日志(?agents=claude,codex,zcode):
 *   claude → ~/.claude/projects/ 下的各 .jsonl 会话日志
 *   codex  → ~/.codex/sessions/ 下的 rollout-*.jsonl 日志
 *   zcode  → ~/.zcode/cli/db/db.sqlite(session/part 表)
 *
 * 认证与 dsh-host-open-in-app 同一机制:`ctx.connection.requestRejection(req)`。
 */

import { homedir } from 'node:os'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'

export const name = 'dsh-advancesearch'
export const inject = ['webServer', 'connection', 'sessionQuery']

const ROUTE = '/api/dsh-advancesearch'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const SCAN_CONCURRENCY = 6
const SNIPPET_CHARS = 160

/** JSON 响应(no-store:搜索结果是实时事实)。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function clampLimit(value) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

/** SessionQueryError → 稳定的 HTTP 状态码。 */
function statusOf(error) {
  const code = String(error?.code ?? '')
  if (code === 'SESSION_QUERY_INVALID_FILTER' || code === 'SESSION_QUERY_INVALID_CURSOR') return 400
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'SESSION_QUERY_EVENT_NOT_FOUND') return 404
  if (code === 'SESSION_QUERY_SEARCH_DISABLED') return 501
  return 500
}

function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /sessionQuery|service.*not|not.*available/i.test(message)
    ? '会话查询服务不可用:当前组合未挂载 session-query 服务。'
    : message
}

/** 大小写不敏感、空白灵活的字面匹配(与官方 compileSessionTextFilter 语义一致)。 */
function makeTextMatcher(query) {
  const pattern = query
    .trim()
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('\\s+')
  return new RegExp(pattern, 'iu')
}

/** 围绕首个命中截取片段。 */
function snippetAround(text, matcher, chars = SNIPPET_CHARS) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (!clean) return null
  const match = matcher.exec(clean)
  if (!match) return null
  if (clean.length <= chars) return clean
  const start = Math.max(0, match.index - Math.floor((chars - (match[0].length || 1)) / 2))
  const prefix = start > 0 ? '…' : ''
  const end = Math.min(clean.length, start + chars)
  return `${prefix}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}


// ---------------------------------------------------------------------------
// 外部 coding agent 会话扫描(claude / codex / zcode)
// ---------------------------------------------------------------------------

const AGENT_IDS = ['claude', 'codex', 'zcode']
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_MATCHES_PER_FILE = 2
const MAX_RESULTS_PER_AGENT = 10

function jsonLinesOf(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) > 0xffff) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

/** 深度遍历 JSON 值,产出其中的文本字符串(跳过 type/id/role 等枚举字段)。 */
function* textsOf(value) {
  if (typeof value === 'string') {
    yield value
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* textsOf(item)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'type' || key === 'id' || key === 'role') continue
      yield* textsOf(item)
    }
  }
}

function firstUserText(lines) {
  for (const line of lines) {
    const role = line?.message?.role ?? line?.payload?.role
    if (role !== 'user') continue
    for (const text of textsOf(line.message?.content ?? line.payload?.content ?? line.payload)) {
      const clean = text.replace(/\s+/gu, ' ').trim()
      if (clean.length >= 4 && !clean.startsWith('<')) return clean
    }
  }
  return null
}

function collectMatches(lines, matcher) {
  const matches = []
  for (const line of lines) {
    for (const text of textsOf(line)) {
      const snippet = snippetAround(text, matcher, SNIPPET_CHARS)
      if (snippet) {
        matches.push(snippet)
        if (matches.length >= MAX_MATCHES_PER_FILE) return matches
      }
    }
  }
  return matches
}

/** 递归收集目录下的 .jsonl 文件(限深,忽略隐藏目录与超大文件)。 */
async function jsonlFilesUnder(root, depth = 4) {
  const files = []
  async function walk(dir, level) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (level < depth && !entry.name.startsWith('.')) await walk(full, level + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          if ((await stat(full)).size <= MAX_FILE_BYTES) files.push(full)
        } catch {}
      }
    }
  }
  await walk(root, 0)
  return files
}

/** 按修改时间新→旧排序。 */
async function newestFirst(files) {
  const withTime = await Promise.all(
    files.map(async (path) => {
      try {
        return { path, time: (await stat(path)).mtimeMs }
      } catch {
        return { path, time: 0 }
      }
    }),
  )
  return withTime.sort((a, b) => b.time - a.time).map((entry) => entry.path)
}

async function scanClaude(query, matcher, limit) {
  const root = join(homedir(), '.claude', 'projects')
  const files = await newestFirst(await jsonlFilesUnder(root))
  const hits = []
  for (const path of files) {
    if (hits.length >= limit) break
    try {
      const lines = jsonLinesOf(await readFile(path, 'utf8'))
      const matches = collectMatches(lines, matcher)
      if (matches.length === 0) continue
      const summary = lines.find((line) => typeof line?.summary === 'string')
      const title =
        firstUserText(lines) ??
        (summary ? summary.summary.slice(0, 60) : null) ??
        path.split('/').at(-1).replace(/\.jsonl$/, '')
      hits.push({
        agent: 'claude',
        id: path.replace(/\.jsonl$/, '').split('/').pop(),
        title,
        time: (await stat(path)).mtimeMs,
        path,
        matches,
      })
    } catch {}
  }
  return hits
}

async function scanCodex(query, matcher, limit) {
  const root = join(homedir(), '.codex', 'sessions')
  const { byThreadId, byRolloutPath } = codexThreadIndexes()
  const files = await newestFirst(await jsonlFilesUnder(root))
  const hits = []
  for (const path of files) {
    if (hits.length >= limit) break
    try {
      const lines = jsonLinesOf(await readFile(path, 'utf8'))
      // developer 角色是注入的指令(AGENTS.md / 权限说明),不参与匹配
      const contentLines = lines.filter(
        (line) => (line?.payload?.role ?? line?.message?.role) !== 'developer',
      )
      const matches = collectMatches(contentLines, matcher)
      const indexed =
        byRolloutPath.get(path) ?? byThreadId.get(threadIdOfRolloutPath(path) ?? '') ?? null
      if (matches.length === 0) {
        // 内容未命中时,标题命中也可入选
        const title = indexed?.title ?? firstUserText(lines)
        if (indexed && typeof title === 'string' && matcher.test(title)) {
          hits.push({
            agent: 'codex',
            id: indexed.id,
            title,
            time: indexed.updated_at,
            path,
            matches: [],
            titleMatch: true,
          })
        }
        continue
      }
      const meta = lines.find((line) => line?.type === 'session_meta')?.payload
      const fallbackTitle = firstUserText(lines) ?? meta?.cwd?.split('/').pop() ?? path.split('/').pop()
      hits.push({
        agent: 'codex',
        id: indexed?.id ?? meta?.id ?? path.split('/').pop().replace(/\.jsonl$/, '').replace(/^rollout-[^-]+-/, ''),
        title: indexed?.title ?? fallbackTitle,
        time: indexed?.updated_at ?? (await stat(path)).mtimeMs,
        path,
        matches,
      })
    } catch {}
  }
  return hits
}

/** Codex 桌面版的线程索引:合并 codex-dev 目录表(CLI 版)与 state_5 threads 表,键分别为线程 id 与 rollout 路径。 */
function codexThreadIndexes() {
  const byThreadId = new Map()
  const byRolloutPath = new Map()
  try {
    const catalog = new DatabaseSync(join(homedir(), '.codex', 'sqlite', 'codex-dev.db'), { readOnly: true })
    try {
      const rows = catalog
        .prepare('SELECT thread_id, display_title, source_updated_at FROM local_thread_catalog')
        .all()
      for (const row of rows) {
        byThreadId.set(row.thread_id, {
          id: row.thread_id,
          title: row.display_title,
          time: Math.round(row.source_updated_at * 1000),
        })
      }
    } finally {
      catalog.close()
    }
  } catch {}
  try {
    const state = new DatabaseSync(join(homedir(), '.codex', 'sqlite', 'state_5.sqlite'), { readOnly: true })
    try {
      const rows = state.prepare('SELECT id, title, rollout_path, updated_at FROM threads').all()
      for (const row of rows) {
        if (row.rollout_path) {
          byRolloutPath.set(row.rollout_path, { id: row.id, title: row.title, time: row.updated_at })
          if (!byThreadId.has(row.id)) byThreadId.set(row.id, { id: row.id, title: row.title, time: row.updated_at })
        }
      }
    } finally {
      state.close()
    }
  } catch {}
  return { byThreadId, byRolloutPath }
}

/** rollout 文件名末尾即线程 uuid:rollout-<时间戳>-<uuid>.jsonl。 */
function threadIdOfRolloutPath(path) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)
  return match ? match[1] : null
}

function zcodeDb() {
  try {
    return new DatabaseSync(join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })
  } catch {
    return null
  }
}

async function scanZcode(query, matcher, limit) {
  const db = zcodeDb()
  if (!db) return []
  try {
    const like = `%${query.replace(/[%_]/g, (ch) => `\\${ch}`)}%`
    const titleRows = db
      .prepare(
        "SELECT id, title, directory, time_updated FROM session WHERE title LIKE ? ESCAPE '\\' ORDER BY time_updated DESC LIMIT ?",
      )
      .all(like, limit)
    const hits = new Map()
    for (const row of titleRows) {
      hits.set(row.id, {
        agent: 'zcode',
        id: row.id,
        title: row.title,
        time: row.time_updated,
        path: row.directory,
        matches: [],
        titleMatch: true,
      })
    }
    // 内容搜索:SQL LIKE 预筛 part 文本,再按语义匹配验证
    const contentRows = db
      .prepare(
        "SELECT p.session_id, p.data, s.title, s.directory, s.time_updated FROM part p JOIN session s ON s.id = p.session_id WHERE p.data LIKE ? ESCAPE '\\' ORDER BY s.time_updated DESC LIMIT 4000",
      )
      .all(like)
    for (const row of contentRows) {
      if (hits.has(row.session_id) && hits.get(row.session_id).matches.length >= MAX_MATCHES_PER_FILE) continue
      let text = null
      try {
        const part = JSON.parse(row.data)
        if (part.type === 'text' && typeof part.text === 'string') text = part.text
        else if (typeof part.thinking === 'string') text = part.thinking
      } catch {}
      if (!text) continue
      const snippet = snippetAround(text, matcher)
      if (!snippet) continue
      const existing = hits.get(row.session_id)
      if (existing) {
        existing.matches.push(snippet)
      } else {
        hits.set(row.session_id, {
          agent: 'zcode',
          id: row.session_id,
          title: row.title,
          time: row.time_updated,
          path: row.directory,
          matches: [snippet],
        })
        if (hits.size >= limit) break
      }
    }
    return [...hits.values()].slice(0, limit)
  } finally {
    db.close()
  }
}

// 供测试与复用导出
export { makeTextMatcher, scanClaude, scanCodex, scanZcode }

// ---------------------------------------------------------------------------
// 外部 agent 动作(打开应用 / 访达显示记录):固定白名单,不执行任意命令
// ---------------------------------------------------------------------------

/** 各 agent 的 macOS 应用 bundle id(用于 open -b 唤起)。 */
const AGENT_BUNDLE_IDS = {
  claude: 'com.anthropic.claudefordesktop',
  codex: 'com.openai.codex',
  zcode: 'dev.zcode.app',
}

/** 允许「访达中显示」的路径前缀(只读揭示,不含写入)。 */
const REVEAL_ALLOWED_ROOTS = [
  join(homedir(), '.claude', 'projects'),
  join(homedir(), '.claude', 'history.jsonl'),
  join(homedir(), '.codex', 'sessions'),
  join(homedir(), '.codex', 'archived_sessions'),
  join(homedir(), '.codex', 'sqlite'),
  join(homedir(), '.zcode', 'cli'),
]

/** 在访达中显示文件/目录;execFile 无 shell,无注入面。 */
function revealInFinder(target) {
  const resolved = String(target)
  if (!resolved.startsWith('/') || !REVEAL_ALLOWED_ROOTS.some((root) => resolved.startsWith(root))) {
    throw new Error('路径不在允许的会话记录目录内')
  }
  return new Promise((resolve, reject) => {
    execFile('open', ['-R', resolved], (error) => (error ? reject(error) : resolve()))
  })
}

/** 唤起对应 agent 桌面应用。 */
function openAgentApp(agent) {
  const bundleId = AGENT_BUNDLE_IDS[agent]
  if (!bundleId) throw new Error(`未知 agent: ${agent}`)
  return new Promise((resolve, reject) => {
    execFile('open', ['-b', bundleId], (error) => (error ? reject(error) : resolve()))
  })
}

const AGENT_SCANNERS = {
  claude: scanClaude,
  codex: scanCodex,
  zcode: scanZcode,
}

/** 扫描选中的外部 agent,串行执行避免 I/O 风暴。 */
async function searchExternalAgents(agents, query, matcher, limit) {
  const external = []
  for (const agent of agents) {
    const scan = AGENT_SCANNERS[agent]
    if (!scan) continue
    try {
      const hits = await scan(query, matcher, limit)
      external.push(...hits)
    } catch (error) {
      console.warn(`[dsh-advancesearch] 扫描 ${agent} 会话失败:`, error?.message ?? error)
    }
  }
  return external.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
}

export function apply(ctx) {
  const connection = Reflect.get(ctx, 'connection')
  const rejected = (req, res) => {
    const rejection = connection?.requestRejection?.(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** 批量读标题,按 id 归并;单个失败不阻塞整体。 */
  async function titleMapOf(ids) {
    const titles = new Map()
    try {
      const snapshots = await ctx.sessionQuery.readTitleSnapshots([...new Set(ids)])
      for (const r of snapshots) {
        if (r.status === 'fulfilled' && typeof r.value.title?.title === 'string') {
          titles.set(r.value.session.id, r.value.title.title)
        }
      }
    } catch {}
    return titles
  }

  /** 全文索引可用时的会话搜索。 */
  async function searchSessionsIndexed(query, limit) {
    const page = await ctx.sessionQuery.searchSessions({ query, limit })
    const titles = await titleMapOf(page.items.map((hit) => hit.header.id))
    return page.items.map((hit) => ({
      id: hit.header.id,
      title: titles.get(hit.header.id) ?? null,
      createdAt: hit.header.createdAt,
      cwd: hit.header.cwd ?? null,
      agentPreset: hit.header.agentPreset ?? null,
      live: hit.live,
      persisted: hit.persisted,
      titleMatch: false,
      snippet: hit.bestMatch?.snippet ?? null,
    }))
  }

  /** 有界并发映射,保持输入顺序。 */
  async function pooledMap(items, limit, worker) {
    const results = new Array(items.length)
    let next = 0
    async function lane() {
      while (next < items.length) {
        const index = next++
        results[index] = await worker(items[index], index)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
    return results
  }

  /** 全文索引被禁用时的回退:逐会话字面扫描(标题 + 内容)。 */
  async function searchSessionsScan(query, limit) {
    const matcher = makeTextMatcher(query)
    const records = await ctx.sessionQuery.listSessions()
    const hits = []
    for (let offset = 0; offset < records.length && hits.length < limit; offset += 50) {
      const batch = records.slice(offset, offset + 50)
      const titles = await titleMapOf(batch.map((r) => r.header.id))
      const batchHits = await pooledMap(batch, SCAN_CONCURRENCY, async (record) => {
        const title = titles.get(record.header.id) ?? null
        const titleMatch = title !== null && matcher.test(title)
        let snippet = null
        try {
          const documents = await ctx.sessionQuery.filterEvents(record.header.id, [
            { kind: 'text', text: query },
          ])
          if (documents.length > 0) snippet = snippetAround(documents[0].text, matcher)
        } catch {}
        if (!titleMatch && snippet === null) return null
        return {
          id: record.header.id,
          title,
          createdAt: record.header.createdAt,
          cwd: record.header.cwd ?? null,
          agentPreset: record.header.agentPreset ?? null,
          live: record.live,
          persisted: record.persisted,
          titleMatch,
          snippet,
        }
      })
      for (const hit of batchHits) {
        if (hit !== null) {
          hits.push(hit)
          if (hits.length >= limit) break
        }
      }
    }
    return hits
  }

  /** 单会话内搜索:优先全文索引,禁用时回退语义扫描。 */
  async function searchInSession(query, sessionId, limit) {
    const matcher = makeTextMatcher(query)
    let events
    try {
      const page = await ctx.sessionQuery.searchEvents({ sessionId, query, limit })
      events = page.items.map((hit) => ({
        seq: hit.seq,
        type: hit.type,
        time: hit.time,
        surface: hit.surface ?? null,
        snippet: hit.snippet,
      }))
    } catch (error) {
      if (String(error?.code ?? '') !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
      const documents = await ctx.sessionQuery.filterEvents(sessionId, [
        { kind: 'text', text: query },
      ])
      events = documents.slice(0, limit).map((doc) => ({
        seq: doc.seq,
        type: doc.type,
        time: doc.time,
        surface: doc.surface ?? null,
        snippet: snippetAround(doc.text, matcher),
      }))
    }
    const titleSnapshot = await ctx.sessionQuery
      .readTitleSnapshots([sessionId])
      .then((rs) => rs[0])
      .catch(() => undefined)
    return {
      ok: true,
      mode: 'events',
      query,
      session: {
        id: sessionId,
        title: titleSnapshot?.status === 'fulfilled' ? (titleSnapshot.value.title ?? null) : null,
      },
      events,
      nextCursor: null,
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          const url = new URL(String(req.url), 'http://localhost')
          const query = (url.searchParams.get('q') ?? '').trim()
          const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
          const limit = clampLimit(url.searchParams.get('limit') ?? '')
          const agents = (url.searchParams.get('agents') ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter((value) => AGENT_IDS.includes(value))
          if (!query) {
            sendError(res, 400, 'empty-query', '缺少查询关键字:使用 ?q=<关键字>')
            return
          }
          try {
            if (sessionId) {
              sendJson(res, 200, await searchInSession(query, sessionId, limit))
              return
            }
            const matcher = makeTextMatcher(query)
            let sessions
            let engine = 'scan'
            try {
              sessions = await searchSessionsIndexed(query, limit)
              engine = 'indexed'
            } catch (error) {
              if (String(error?.code ?? '') !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
              sessions = await searchSessionsScan(query, limit)
            }
            let external = []
            if (agents.length > 0) {
              external = await searchExternalAgents(agents, query, matcher, limit)
            }
            sendJson(res, 200, {
              ok: true,
              mode: 'sessions',
              query,
              engine,
              sessions,
              external,
              nextCursor: null,
            })
          } catch (error) {
            sendError(res, statusOf(error), String(error?.code ?? 'search-failed'), messageOf(error))
          }
        },
      }),
    'dsh-advancesearch: GET ' + ROUTE,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE + '/action',
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          let body
          try {
            body = JSON.parse(await readBoundedBody(req, 2048))
          } catch {
            sendError(res, 400, 'bad-request', '请求体必须是 JSON')
            return
          }
          try {
            switch (body.action) {
              case 'open-app': {
                if (!AGENT_IDS.includes(body.agent)) throw new Error('未知 agent')
                await openAgentApp(body.agent)
                break
              }
              case 'reveal': {
                await revealInFinder(body.path)
                break
              }
              default:
                sendError(res, 400, 'unknown-action', '不支持的动作')
                return
            }
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendError(res, 400, 'action-failed', error instanceof Error ? error.message : String(error))
          }
        },
      }),
    'dsh-advancesearch: POST ' + ROUTE + '/action',
  )
}

/** 读取有界 JSON 请求体。 */
async function readBoundedBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.resume()
      throw new Error('body too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
