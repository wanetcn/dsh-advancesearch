/**
 * dsh-advancesearch — DeepSeek Harness 高级搜索插件(Host 侧)。
 *
 * 通过 `sessionQuery` 服务提供已认证搜索路由:
 *   GET  /api/dsh-advancesearch?q=关键字[&limit=20]
 *        → 搜索所有 DSH 会话(标题 + 内容),返回会话命中与片段
 *   GET  /api/dsh-advancesearch?q=关键字&sessionId=<id>[&limit=20]
 *        → 在单个会话内搜索,返回逐条片段
 *   POST /api/dsh-advancesearch/action
 *        → 外部 agent 动作:open-app / reveal(固定白名单)
 *
 * DSH 会话优先使用后端全文索引(searchSessions/searchEvents);当部署把索引配置为
 * openAt "never"(桌面组合默认如此)时,自动回退到官方语义扫描接口
 * listSessions + filterEvents(字面、大小写不敏感、空白灵活匹配)。
 *
 * 另支持搜索本机外部 coding agent 的会话日志(?agents=claude,codex,zcode,gemini):
 * 扫描逻辑统一在 ./mcp/lib/scanners.js,与 MCP 服务器共享。
 *
 * 认证与 dsh-host-open-in-app 同一机制:`ctx.connection.requestRejection(req)`。
 */

import { execFile } from 'node:child_process'
import {
  AGENT_IDS,
  AGENT_SCANNERS,
  makeTextMatcher as agentMatcher,
  REVEAL_ALLOWED_ROOTS,
  AGENT_BUNDLE_IDS,
} from './mcp/lib/scanners.js'

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

/** 批量读取会话标题,按 id 归并;单个失败不阻塞整体。 */
async function titleMapOf(sessionQuery, ids) {
  const titles = new Map()
  try {
    const snapshots = await sessionQuery.readTitleSnapshots([...new Set(ids)])
    for (const r of snapshots) {
      if (r.status === 'fulfilled' && typeof r.value.title?.title === 'string') {
        titles.set(r.value.session.id, r.value.title.title)
      }
    }
  } catch {}
  return titles
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

/** 全文索引可用时的会话搜索。 */
async function searchSessionsIndexed(ctx, query, matcher, limit) {
  const page = await ctx.sessionQuery.searchSessions({ query, limit })
  const titles = await titleMapOf(ctx, page.items.map((hit) => hit.header.id))
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

/** 全文索引被禁用时的回退:逐会话字面扫描(标题 + 内容)。 */
async function searchSessionsScan(ctx, query, matcher, limit) {
  const records = await ctx.sessionQuery.listSessions()
  const hits = []
  for (let offset = 0; offset < records.length && hits.length < limit; offset += 50) {
    const batch = records.slice(offset, offset + 50)
    const titles = await titleMapOf(ctx, batch.map((r) => r.header.id))
    const batchHits = await pooledMap(batch, SCAN_CONCURRENCY, async (record) => {
      const title = titles.get(record.header.id) ?? null
      const titleMatch = title !== null && matcher.test(title)
      let snippet = null
      try {
        const documents = await ctx.sessionQuery.filterEvents(record.header.id, [
          { kind: 'text', text: query },
        ])
        if (documents.length > 0) {
          const clean = String(documents[0].text ?? '').replace(/\s+/gu, ' ').trim()
          const m = matcher.exec(clean)
          if (m) {
            const start = Math.max(0, m.index - 40)
            snippet =
              (start > 0 ? '…' : '') + clean.slice(start, start + SNIPPET_CHARS) +
              (start + SNIPPET_CHARS < clean.length ? '…' : '')
          }
        }
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
async function searchInSession(ctx, query, matcher, sessionId, limit) {
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
      snippet: (() => {
        const clean = String(doc.text ?? '').replace(/\s+/gu, ' ').trim()
        const m = matcher.exec(clean)
        if (!m) return null
        const start = Math.max(0, m.index - 40)
        return (start > 0 ? '…' : '') + clean.slice(start, start + SNIPPET_CHARS) +
          (start + SNIPPET_CHARS < clean.length ? '…' : '')
      })(),
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
      title: titleSnapshot?.status === 'fulfilled' ? (titleSnapshot.value.title?.title ?? null) : null,
    },
    events,
    nextCursor: null,
  }
}

/** 扫描选中的外部 agent,串行执行避免 I/O 风暴。 */
async function searchExternalAgents(agents, query, matcher, limit) {
  const external = []
  for (const agent of agents) {
    const scan = AGENT_SCANNERS[agent]
    if (!scan) continue
    try {
      external.push(...(await scan(query, matcher, limit)))
    } catch (error) {
      console.warn(`[dsh-advancesearch] 扫描 ${agent} 会话失败:`, error?.message ?? error)
    }
  }
  return external.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
}

// ---------------------------------------------------------------------------
// 外部 agent 动作(打开应用 / 访达显示记录):固定白名单,不执行任意命令
// ---------------------------------------------------------------------------

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

export function apply(ctx) {
  const connection = Reflect.get(ctx, 'connection')
  const rejected = (req, res) => {
    const rejection = connection?.requestRejection?.(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
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
              sendJson(res, 200, await searchInSession(ctx, query, agentMatcher(query), sessionId, limit))
              return
            }
            const matcher = agentMatcher(query)
            let sessions
            let engine = 'scan'
            try {
              sessions = await searchSessionsIndexed(ctx, query, matcher, limit)
              engine = 'indexed'
            } catch (error) {
              if (String(error?.code ?? '') !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
              sessions = await searchSessionsScan(ctx, query, matcher, limit)
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
