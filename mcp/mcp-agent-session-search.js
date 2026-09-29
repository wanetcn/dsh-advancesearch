#!/usr/bin/env node
/**
 * agent-session-search-mcp — 零依赖 MCP stdio 服务器。
 *
 * 让 MCP 客户端(DeepSeek Harness / Claude Desktop 等)的 agent 通过工具调用
 * 搜索本机外部 coding agent(Claude Code / Codex / ZCode)的会话记录:
 *   - search_agent_sessions   关键字搜索(标题 + 内容),返回命中片段
 *   - read_agent_session      读取某个会话的最近消息文本
 *   - open_agent_app          唤起对应 agent 桌面应用
 *   - reveal_agent_session    在访达中显示会话记录文件
 *
 * 协议:JSON-RPC 2.0,每行一个消息(MCP stdio 传输)。
 */
import { createInterface } from 'node:readline'
import {
  AGENT_IDS,
  AGENT_BUNDLE_IDS,
  makeTextMatcher,
  scanClaude,
  scanCodex,
  scanZcode,
  scanGemini,
  revealInFinder,
  openAgentApp,
} from './lib/scanners.js'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'

const SERVER_INFO = { name: 'agent-session-search', version: '0.1.0' }

// ---------------------------------------------------------------------------
// 会话内容读取(供 read_agent_session)
// ---------------------------------------------------------------------------

async function readClaudeSession(path, limit) {
  const lines = JSON.parse('[]')
  const text = readFileSync(path, 'utf8')
  for (const line of text.split('\n')) {
    try {
      lines.push(JSON.parse(line))
    } catch {}
  }
  const out = []
  for (const line of lines) {
    const role = line?.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    for (const item of Array.isArray(line.message?.content) ? line.message.content : []) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        out.push({ role, text: item.text.trim() })
        break
      }
    }
    if (out.length >= limit) break
  }
  return out
}

async function readCodexSession(path, limit) {
  const text = readFileSync(path, 'utf8')
  const out = []
  for (const line of text.split('\n')) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed?.type !== 'response_item' || parsed?.payload?.type !== 'message') continue
    const role = parsed.payload.role
    if (role !== 'user' && role !== 'assistant') continue
    for (const item of Array.isArray(parsed.payload.content) ? parsed.payload.content : []) {
      if (typeof item?.text === 'string' && item.text.trim()) {
        out.push({ role, text: item.text.trim() })
        break
      }
    }
    if (out.length >= limit) break
  }
  return out
}

function readZcodeSession(sessionId, limit) {
  const db = new DatabaseSync(join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })
  try {
    const rows = db
      .prepare(
        `SELECT m.data AS message_data, p.data AS part_data
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ? ORDER BY p.time_created`,
      )
      .all(sessionId)
    const out = []
    for (const row of rows) {
      let role = 'user'
      let text = null
      try {
        role = JSON.parse(row.message_data)?.role ?? role
        const part = JSON.parse(row.part_data)
        if (part.type === 'text' && typeof part.text === 'string') text = part.text
      } catch {}
      if (!text || !text.trim()) continue
      out.push({ role, text: text.trim() })
      if (out.length >= limit) break
    }
    return out
  } finally {
    db.close()
  }
}

/** 解析外部命中到 {agent, path?, sessionId?}。 */
function resolveTarget(agent, id, path) {
  if (agent === 'zcode') return { sessionId: id }
  if (agent === 'claude') return { path: path ?? findFileUnder(join(homedir(), '.claude', 'projects'), id) }
  if (agent === 'codex') return { path: path ?? findFileUnder(join(homedir(), '.codex', 'sessions'), id) }
  if (agent === 'gemini') return { path: path ?? findFileUnder(join(homedir(), '.gemini', 'tmp'), id) }
  throw new Error(`未知 agent: ${agent}`)
}

function findFileUnder(root, id) {
  try {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, `${id}.jsonl`)
      try {
        readFileSync(candidate)
        return candidate
      } catch {}
    }
  } catch {}
  throw new Error(`找不到会话文件: ${id}`)
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const agentEnum = { enum: AGENT_IDS }

const TOOLS = [
  {
    name: 'search_agent_sessions',
    description:
      '按关键字搜索本机外部 coding agent(Claude Code / Codex / ZCode)的历史会话,标题与内容都参与匹配,' +
      '返回会话标题、时间、命中片段与记录文件路径。适合回答"我之前让哪个 agent 做过 XX"类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键字' },
        agents: { type: 'array', items: agentEnum, description: '要搜索的 agent,缺省为全部三种' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '每个 agent 最多返回条数,默认 10' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_agent_session',
    description: '读取某个外部 agent 会话的最近消息(user/assistant 文本)。需要先由 search_agent_sessions 拿到 agent、id 和 path。',
    inputSchema: {
      type: 'object',
      properties: {
        agent: agentEnum,
        id: { type: 'string', description: '会话 id(search 结果的 id 字段)' },
        path: { type: 'string', description: '记录文件路径(search 结果的 path 字段;zcode 无需提供)' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回消息条数,默认 50' },
      },
      required: ['agent', 'id'],
    },
  },
  {
    name: 'open_agent_app',
    description: '唤起对应 agent 的桌面应用(macOS open -b)。无会话级深链,应用打开后停留在最近会话列表。',
    inputSchema: {
      type: 'object',
      properties: { agent: agentEnum },
      required: ['agent'],
    },
  },
  {
    name: 'reveal_agent_session',
    description: '在 macOS 访达中显示某个会话的记录文件(仅允许各 agent 会话记录目录内的路径)。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '记录文件绝对路径' } },
      required: ['path'],
    },
  },
]

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

async function toolSearch({ query, agents, limit = 10 }) {
  const trimmed = String(query ?? '').trim()
  if (!trimmed) throw new Error('query 不能为空')
  const matcher = makeTextMatcher(trimmed)
  const wanted = (Array.isArray(agents) && agents.length > 0 ? agents : AGENT_IDS).filter((agent) =>
    AGENT_IDS.includes(agent),
  )
  const scanners = { claude: scanClaude, codex: scanCodex, zcode: scanZcode, gemini: scanGemini }
  const lines = []
  for (const agent of wanted) {
    const hits = await scanners[agent](trimmed, matcher, Math.min(limit, 50))
    lines.push(`## ${agent}(${hits.length} 条)`)
    for (const hit of hits) {
      lines.push(
        `- [${hit.agent}] ${hit.title}\n  时间: ${new Date(hit.time).toLocaleString('zh-CN')} | id: ${hit.id}` +
          (hit.path ? ` | 路径: ${hit.path}` : ''),
      )
      for (const snippet of hit.matches ?? []) lines.push(`  片段: ${snippet}`)
      if (hit.titleMatch && (hit.matches ?? []).length === 0) lines.push('  (标题命中)')
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') || '无结果' }] }
}

function readGeminiSession(path, limit) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const type = parsed?.type
    if ((type === 'user' || type === 'gemini') && typeof parsed?.content === 'string' && parsed.content.trim()) {
      out.push({ role: type === 'user' ? 'user' : 'assistant', text: parsed.content.trim() })
    }
    if (out.length >= limit) break
  }
  return out
}

async function toolRead({ agent, id, path, limit = 50 }) {
  if (!AGENT_IDS.includes(agent)) throw new Error(`未知 agent: ${agent}`)
  const target = resolveTarget(agent, id, path)
  const messages =
    agent === 'zcode'
      ? readZcodeSession(target.sessionId, limit)
      : agent === 'claude'
        ? await readClaudeSession(target.path, limit)
        : agent === 'gemini'
          ? readGeminiSession(target.path, limit)
          : await readCodexSession(target.path, limit)
  const text =
    messages.map((message) => `[${message.role}] ${message.text}`).join('\n\n') || '(该会话没有可读文本消息)'
  return { content: [{ type: 'text', text }] }
}

async function toolOpen({ agent }) {
  const bundleId = AGENT_BUNDLE_IDS[agent]
  if (!bundleId) throw new Error(`未知 agent: ${agent}`)
  await new Promise((resolve, reject) =>
    execFile('open', ['-b', bundleId], (error) => (error ? reject(error) : resolve())),
  )
  return { content: [{ type: 'text', text: `已唤起 ${agent} 应用` }] }
}

async function toolReveal({ path }) {
  await revealInFinder(path)
  return { content: [{ type: 'text', text: '已在访达中显示' }] }
}

const TOOL_HANDLERS = {
  search_agent_sessions: toolSearch,
  read_agent_session: toolRead,
  open_agent_app: toolOpen,
  reveal_agent_session: toolReveal,
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

let pendingCalls = 0
const readline = createInterface({ input: process.stdin })
readline.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
        break
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break
      case 'ping':
        respond(id, {})
        break
      case 'tools/list':
        respond(id, { tools: TOOLS })
        break
      case 'tools/call': {
        const tool = TOOLS.find((tool) => tool.name === params?.name)
        if (!tool) {
          respondError(id, -32602, `未知工具: ${params?.name}`)
          break
        }
        pendingCalls++
        Promise.resolve(TOOL_HANDLERS[params.name](params.arguments ?? {}))
          .then((result) => respond(id, result))
          .catch((error) =>
            respond(id, {
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            }),
          )
          .finally(() => {
            pendingCalls--
            if (!process.stdin.readable && pendingCalls === 0) process.exit(0)
          })
        break
      }
      default:
        if (id !== undefined) respondError(id, -32601, `未知方法: ${method}`)
    }
  } catch (error) {
    if (id !== undefined) respondError(id, -32603, error instanceof Error ? error.message : String(error))
  }
})
readline.on('close', () => {
  if (pendingCalls === 0) process.exit(0)
  // 否则等在途调用完成后由 finally 退出
})
