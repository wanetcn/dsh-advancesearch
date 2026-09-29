/**
 * 外部 coding agent 会话扫描器(claude / codex / zcode)。
 * 与 dsh-advancesearch 插件共用同一套解析逻辑;零依赖,可独立运行于 Node >= 22。
 */
import { homedir } from 'node:os'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SNIPPET_CHARS = 160
export const AGENT_IDS = ['claude', 'codex', 'zcode', 'gemini']

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
    const role = line?.message?.role ?? line?.payload?.role ?? (line?.type === 'user' ? 'user' : undefined)
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


// ---------------------------------------------------------------------------
// 外部 agent 动作(打开应用 / 访达显示记录):固定白名单,不执行任意命令
// ---------------------------------------------------------------------------

/** 各 agent 的 macOS 应用 bundle id(用于 open -b 唤起)。 */
const AGENT_BUNDLE_IDS = {
  claude: 'com.anthropic.claudefordesktop',
  codex: 'com.openai.codex',
  zcode: 'dev.zcode.app',
  gemini: 'com.google.Gemini',
}

/** 允许「访达中显示」的路径前缀(只读揭示,不含写入)。 */
const REVEAL_ALLOWED_ROOTS = [
  join(homedir(), '.claude', 'projects'),
  join(homedir(), '.claude', 'history.jsonl'),
  join(homedir(), '.codex', 'sessions'),
  join(homedir(), '.codex', 'archived_sessions'),
  join(homedir(), '.codex', 'sqlite'),
  join(homedir(), '.zcode', 'cli'),
  join(homedir(), '.gemini'),
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


/** Gemini CLI:~/.gemini/tmp/<hash>/chats/session-*.jsonl,消息行 {type:'user'|'gemini', content}。 */
async function scanGemini(query, matcher, limit) {
  const root = join(homedir(), '.gemini', 'tmp')
  const files = await newestFirst(await jsonlFilesUnder(root))
  const hits = []
  for (const path of files) {
    if (hits.length >= limit) break
    try {
      const lines = jsonLinesOf(await readFile(path, 'utf8'))
      const header = lines.find((line) => line?.sessionId)
      const contentLines = lines.filter((line) => line?.type === 'user' || line?.type === 'gemini')
      const matches = collectMatches(contentLines, matcher)
      const title = firstUserText(contentLines) ??
        (header ? `Gemini 会话 ${String(header.startTime ?? '').slice(0, 10)}` : null) ??
        path.split('/').pop()
      if (matches.length === 0) continue
      hits.push({
        agent: 'gemini',
        id: header?.sessionId ?? path.split('/').pop().replace(/\.jsonl$/, ''),
        title,
        time: header?.lastUpdated ? Date.parse(header.lastUpdated) || 0 : (await stat(path)).mtimeMs,
        path,
        matches,
      })
    } catch {}
  }
  return hits
}

const AGENT_SCANNERS = { claude: scanClaude, codex: scanCodex, zcode: scanZcode, gemini: scanGemini }
export { makeTextMatcher, snippetAround, scanClaude, scanCodex, scanZcode, scanGemini, AGENT_BUNDLE_IDS, AGENT_SCANNERS, revealInFinder, openAgentApp, REVEAL_ALLOWED_ROOTS }
