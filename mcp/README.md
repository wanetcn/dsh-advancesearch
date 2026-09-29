# agent-session-search-mcp

零依赖的 MCP(stdio)服务器:让 agent 通过工具调用搜索本机 **Claude Code / Codex / ZCode** 的历史会话(标题 + 内容)。

## 工具

| 工具 | 说明 |
|---|---|
| `search_agent_sessions` | 关键字搜索会话(标题+内容),返回标题、时间、片段、id、记录路径 |
| `read_agent_session` | 读取某个会话的最近 user/assistant 消息文本 |
| `open_agent_app` | 唤起对应 agent 桌面应用 |
| `reveal_agent_session` | 在访达中显示会话记录文件 |

## 数据源

- Claude Code:`~/.claude/projects/**/*.jsonl`
- Codex:`~/.codex/sessions/**/rollout-*.jsonl`(标题来自 `codex-dev.db` / `state_5.sqlite` 线程索引)
- ZCode:`~/.zcode/cli/db/db.sqlite`(session/part 表)

要求:macOS,Node ≥ 22.5(使用内置 `node:sqlite`)。

## 在 DeepSeek Harness 中使用

`cordis.patch.yml` 加一段(dsh-base 组合自带 `dsh-mcp-client`):

```yaml
- insert:
    - id: mcp-agent-session-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-session-search
        transport: stdio
        command: node
        args: ['/path/to/dsh-advancesearch/mcp/mcp-agent-session-search.js']
```

重启后模型即可调用 `mcp__agent-session-search__search_agent_sessions` 等工具。

## 在 Claude Desktop 等通用客户端中使用

```json
{
  "mcpServers": {
    "agent-session-search": {
      "command": "node",
      "args": ["/path/to/dsh-advancesearch/mcp/mcp-agent-session-search.js"]
    }
  }
}
```
