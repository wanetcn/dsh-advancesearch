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
 * 认证与 dsh-host-open-in-app 同一机制:`ctx.connection.requestRejection(req)`。
 */

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
  if (!match || clean.length <= chars) return clean || null
  const start = Math.max(0, match.index - Math.floor((chars - (match[0].length || 1)) / 2))
  const prefix = start > 0 ? '…' : ''
  const end = Math.min(clean.length, start + chars)
  return `${prefix}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
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
          if (!query) {
            sendError(res, 400, 'empty-query', '缺少查询关键字:使用 ?q=<关键字>')
            return
          }
          try {
            if (sessionId) {
              sendJson(res, 200, await searchInSession(query, sessionId, limit))
              return
            }
            let sessions
            let engine = 'scan'
            try {
              sessions = await searchSessionsIndexed(query, limit)
              engine = 'indexed'
            } catch (error) {
              if (String(error?.code ?? '') !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
              sessions = await searchSessionsScan(query, limit)
            }
            sendJson(res, 200, { ok: true, mode: 'sessions', query, engine, sessions, nextCursor: null })
          } catch (error) {
            sendError(res, statusOf(error), String(error?.code ?? 'search-failed'), messageOf(error))
          }
        },
      }),
    'dsh-advancesearch: GET ' + ROUTE,
  )
}
