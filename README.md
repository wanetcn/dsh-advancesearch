# dsh-advancesearch

DeepSeek Harness 插件:按关键字搜索**所有会话**的名称与会话内容,并在 Web 工作区界面提供搜索按钮。

不只搜 DSH 自己的会话——勾选后可以同时搜索本机 **Claude Code、Codex、ZCode、Gemini CLI** 等 coding agent 的历史会话(标题 + 内容),还内置 MCP 服务器,让 agent 自己也能检索这些历史记录。

- **Host 侧**(`index.js`):通过 DSH 官方 `sessionQuery` 服务(`dsh-session-query-sqlite` 全文索引)暴露已认证的搜索路由 `GET /api/dsh-advancesearch`,与 `dsh-host-open-in-app` 使用同一 `connection.requestRejection` 信任围栏。
- **外部 Agent 会话搜索**:勾选 Claude / Codex / ZCode 后,同时扫描本机 `~/.claude/projects`、`~/.codex/sessions`、`~/.zcode/cli/db` 的会话日志(标题 + 内容),勾选状态持久化保留;
- **Client 侧**(`client.js`):以官方 `dsh.client` 浏览器插件格式(`window.__ModuleLoader__`)加载,在侧边栏底部(`sidebar.footer.action` 槽位)注册一个 🔍 按钮,点击弹出全局搜索层(`shell.overlay` 槽位):输入关键字 → 回车 → 列出所有命中会话(标题 + 最佳片段,关键字高亮)→ 点击某会话展开该会话内的逐条命中。

## 搜索能力

| 模式 | 数据来源 | 说明 |
|------|----------|------|
| 按会话搜索(默认) | `sessionQuery.searchSessions()` | 全文检索所有会话的标题与内容,返回每个会话的最佳命中片段 |
| 会话内搜索 | `sessionQuery.searchEvents()` | 在单个会话内逐条列出命中事件片段(带序号与类型) |

标题取自 `readTitleSnapshots()`(官方标题折叠结果);搜索覆盖进行中的会话与已持久化会话。

## Agent 工具(MCP)

插件内置一个零依赖的 MCP stdio 服务器(`mcp/`),安装插件后**自动注册**,模型可直接调用:

| 工具 | 功能 |
|---|---|
| `mcp__agent-session-search__search_agent_sessions` | 关键字搜索 Claude / Codex / ZCode 会话(标题+内容),返回标题、时间、片段、路径 |
| `mcp__agent-session-search__read_agent_session` | 读取某个会话的最近消息全文 |
| `mcp__agent-session-search__open_agent_app` | 唤起对应 agent 桌面应用 |
| `mcp__agent-session-search__reveal_agent_session` | 在访达中显示会话记录文件 |

MCP 服务器路径通过 `!!js` 相对插件根动态解析,无需写死路径;`command` 优先取
`DSH_DESKTOP_NODE_EXECUTABLE` 环境变量,否则回落到 `node`。

不装插件、只想在 Claude Desktop 等其他 MCP 客户端里用?见 [mcp/README.md](mcp/README.md) 的独立接入配置。

### 会话内调用示例

装好重启后,直接用自然语言说话,agent 会自己调用工具。几个典型场景:

**① 翻历史:「我之前让 codex 配置过某个服务,翻出来看看」**

```text
你: 我记得在 codex 里配置过某个服务,帮我找出来看看当时怎么配的

agent: (调用 search_agent_sessions,query="服务配置", agents=["codex"])
agent: (调用 read_agent_session,读取最相关会话的消息原文)
agent: 找到了 9 月 14 日的会话「XX 服务的配置文件调整」,当时的方案是:
       入站监听本地端口,证书放到指定目录…
       参考当时的配置,这次建议这样写:…
```

**② 跨 agent 找方案:「所有 agent 里谁讨论过这个系统」**

```text
你: 搜一下所有 agent 里关于这个项目的讨论,把最相关那个会话的原文读给我

agent: (search_agent_sessions,query="项目部署",agents=["claude","codex","zcode"])
agent: 共 12 条命中:
       [Codex]  巡检任务执行记录     — 9月28日
       [ZCode]  每日报表汇总生成     — 定时任务
       [Claude] 代码目录迁移调整
       最相关的是 Codex 的「查询服务器地址端口」,原文如下:…
```

**③ 变成 agent 的记忆:接续半个月前的任务**

```text
你: 上个月我让 zcode 改过某个驱动的下载地址,改成什么了?

agent: (search_agent_sessions → read_agent_session)
agent: 8 月 21 日的会话「更新某驱动的下载地址」里,旧地址已替换为新地址,
       并同步更新了部署脚本中的引用,…
```

**④ 操作类:「打开 zcode」/「在访达里显示那条记录」**

调用 `open_agent_app` / `reveal_agent_session`,直接唤起应用或定位记录文件。

> 💡 工具名带 `mcp__agent-session-search__` 前缀;在轨迹页可以看到每次调用的参数与结果。
> 搜索语义:字面、大小写不敏感、空白灵活匹配(如 `web app` 能命中 `WebApp` 这种连写形式)。

## 安装

在 DSH profile 目录(如 `~/.dsh/profiles/web/`):

```bash
pnpm add file:/path/to/dsh-advancesearch
# 或发布后:
pnpm add github:<you>/dsh-advancesearch
```

然后在同一目录的 `cordis.patch.yml` 里加一行启用:

```yaml
- name: dsh-advancesearch
```

重启(或开启 HMR 时保存即生效)后,Web 界面侧边栏底部会出现 **🔍 搜索会话** 按钮;侧边栏收起时只显示图标。

## API

```
GET /api/dsh-advancesearch?q=<关键字>[&limit=20]
GET /api/dsh-advancesearch?q=<关键字>&sessionId=<id>[&limit=20]
```

- `limit` 1–50,默认 20;
- 需要浏览器会话凭据(与 GUI 同源 cookie),不可信来源按 DSH 信任围栏拒绝;
- 未挂载 `session-query` 后端的组合会返回 `501 SESSION_QUERY_SEARCH_DISABLED`。

## 目录结构

```text
dsh-advancesearch/
  package.json   name / exports(./client)/ dsh.client.platform = web
  index.js       Host 侧:webServer 路由 + sessionQuery 搜索
  client.js      Client 侧:搜索按钮 + 搜索弹层(ModuleLoader bundle)
  README.md
```

## 已知限制

- 搜索走 `dsh-session-query-sqlite` 的全文索引,`openAt: "never"` 的部署不可用;
- 弹层样式使用内联样式与主题变量兜底,未接入官方 locale 体系(界面文案为中文);
- 分页游标(`nextCursor`)暂未在 UI 中暴露,默认每会话/每页 20 条。

## License

MIT
