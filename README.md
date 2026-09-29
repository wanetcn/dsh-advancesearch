# dsh-advancesearch

DeepSeek Harness 插件:按关键字搜索**所有会话**的名称与会话内容,并在 Web 工作区界面提供搜索按钮。

- **Host 侧**(`index.js`):通过 DSH 官方 `sessionQuery` 服务(`dsh-session-query-sqlite` 全文索引)暴露已认证的搜索路由 `GET /api/dsh-advancesearch`,与 `dsh-host-open-in-app` 使用同一 `connection.requestRejection` 信任围栏。
- **Client 侧**(`client.js`):以官方 `dsh.client` 浏览器插件格式(`window.__ModuleLoader__`)加载,在侧边栏底部(`sidebar.footer.action` 槽位)注册一个 🔍 按钮,点击弹出全局搜索层(`shell.overlay` 槽位):输入关键字 → 回车 → 列出所有命中会话(标题 + 最佳片段,关键字高亮)→ 点击某会话展开该会话内的逐条命中。

## 搜索能力

| 模式 | 数据来源 | 说明 |
|------|----------|------|
| 按会话搜索(默认) | `sessionQuery.searchSessions()` | 全文检索所有会话的标题与内容,返回每个会话的最佳命中片段 |
| 会话内搜索 | `sessionQuery.searchEvents()` | 在单个会话内逐条列出命中事件片段(带序号与类型) |

标题取自 `readTitleSnapshots()`(官方标题折叠结果);搜索覆盖进行中的会话与已持久化会话。

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
