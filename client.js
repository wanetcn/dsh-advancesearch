/**
 * dsh-advancesearch — 浏览器侧插件(client bundle)。
 *
 * 格式与官方 client 产物一致:window.__ModuleLoader__.load({ id, factory })。
 * 在侧边栏底部(sidebar.footer.action)注册一个搜索按钮,点击打开全局弹层
 * (shell.overlay):输入关键字 → 搜索所有会话的名称与内容 → 展示结果,
 * 点击某个会话可进一步查看该会话内的逐条命中片段。
 */
window.__ModuleLoader__.load({
	id: "dsh-advancesearch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		//#region 搜索按钮 + 全局搜索弹层
		const e = react.createElement;

		const openState = { open: false, initialQuery: "", listeners: new Set() };
		function setOpen(next, initialQuery) {
			openState.open = next;
			openState.initialQuery = initialQuery ?? "";
			for (const listener of openState.listeners) listener();
		}
		function subscribeOpen(listener) {
			openState.listeners.add(listener);
			return () => {
				openState.listeners.delete(listener);
			};
		}

		/** 可选的外部 agent 会话源;勾选状态持久化,下次打开保持。 */
		const AGENT_OPTIONS = [
			{ id: "claude", label: "Claude" },
			{ id: "codex", label: "Codex" },
			{ id: "zcode", label: "ZCode" },
		];
		const AGENTS_STORE_KEY = "advancesearch.agents";
		function loadSelectedAgents() {
			try {
				const saved = JSON.parse(window.localStorage.getItem(AGENTS_STORE_KEY) ?? "[]");
				return Array.isArray(saved) ? saved.filter((id) => AGENT_OPTIONS.some((option) => option.id === id)) : [];
			} catch {
				return [];
			}
		}
		function saveSelectedAgents(ids) {
			try {
				window.localStorage.setItem(AGENTS_STORE_KEY, JSON.stringify(ids));
			} catch {}
		}

		/** GET /api/dsh-advancesearch —— Host 侧本插件提供的已认证路由。 */
		async function runSearch(params) {
			const url = new URL("/api/dsh-advancesearch", window.location.origin);
			url.searchParams.set("q", params.query);
			url.searchParams.set("limit", String(params.limit ?? 20));
			if (params.sessionId) url.searchParams.set("sessionId", params.sessionId);
			if (params.agents && params.agents.length > 0) url.searchParams.set("agents", params.agents.join(","));
			const response = await fetch(url, { credentials: "same-origin" });
			const payload = await response.json().catch(() => null);
			if (!response.ok || !payload || payload.ok !== true) {
				throw new Error(payload && payload.error ? payload.error.message : `搜索失败(HTTP ${response.status})`);
			}
			return payload;
		}

		/** 把片段中的关键字包上高亮,返回 React 节点数组。 */
		function highlight(snippet, query) {
			if (!snippet) return null;
			const needles = query.split(/\s+/).filter(Boolean);
			if (needles.length === 0) return snippet;
			const lower = snippet.toLowerCase();
			const marks = new Array(snippet.length).fill(false);
			for (const needle of needles) {
				const n = needle.toLowerCase();
				let at = lower.indexOf(n);
				while (at !== -1) {
					for (let i = at; i < at + n.length; i++) marks[i] = true;
					at = lower.indexOf(n, at + n.length);
				}
			}
			const parts = [];
			let current = "";
			let currentMark = marks[0] ?? false;
			for (let i = 0; i < snippet.length; i++) {
				if (marks[i] === currentMark) current += snippet[i];
				else {
					parts.push({ text: current, mark: currentMark });
					current = snippet[i];
					currentMark = marks[i];
				}
			}
			parts.push({ text: current, mark: currentMark });
			return parts.map((part, index) =>
				part.mark
					? e("mark", { key: index, style: { background: "color-mix(in srgb, #ffc400 45%, transparent)", color: "inherit", borderRadius: 2, padding: "0 1px" } }, part.text)
					: part.text,
			);
		}

		function formatTime(value) {
			if (!value) return "";
			try {
				return new Date(value).toLocaleString();
			} catch {
				return String(value);
			}
		}

		/** 侧边栏底部按钮。槽位载荷:{ wide }。 */
		function SearchButton(props) {
			const open = react.useSyncExternalStore(subscribeOpen, () => openState.open);
			const wide = props && props.wide;
			return e(
				"button",
				{
					title: "高级搜索(所有会话)",
					"aria-label": "高级搜索",
					onClick: () => setOpen(true),
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						border: "none",
						background: "transparent",
						color: "inherit",
						opacity: 0.72,
						cursor: "pointer",
						padding: "6px 10px",
						borderRadius: 8,
						fontSize: 13,
						lineHeight: 1,
						width: wide ? "100%" : "auto",
						justifyContent: wide ? "flex-start" : "center",
					},
					onMouseEnter: (ev) => {
						ev.currentTarget.style.opacity = "1";
						ev.currentTarget.style.background = "rgba(127, 127, 127, 0.14)";
					},
					onMouseLeave: (ev) => {
						ev.currentTarget.style.opacity = "0.72";
						ev.currentTarget.style.background = "transparent";
					},
				},
				e(
					"svg",
					{
						width: 16,
						height: 16,
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 2,
						strokeLinecap: "round",
						strokeLinejoin: "round",
						"aria-hidden": true,
					},
					e("circle", { key: "c", cx: 11, cy: 11, r: 7 }),
					e("line", { key: "l", x1: 21, y1: 21, x2: 16.5, y2: 16.5 }),
				),
				wide ? e("span", { key: "t" }, "搜索会话") : null,
			);
		}

		/** 单个会话命中的展开行:查看会话内逐条片段;右键或点按钮跳转到该会话。 */
		function SessionHits(props) {
			const { item, query, onJump, onMenu } = props;
			const [events, setEvents] = react.useState(undefined);
			const [error, setError] = react.useState(null);
			const [expanded, setExpanded] = react.useState(false);
			const toggle = () => {
				const next = !expanded;
				setExpanded(next);
				if (!next || events !== undefined || error !== null) return;
				runSearch({ query, sessionId: item.id, limit: 10 })
					.then((payload) => setEvents(payload.events))
					.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
			};
			return e(
				"div",
				{ style: { borderBottom: "1px solid rgba(127,127,127,0.18)" } },
				e(
					"button",
					{
						onClick: toggle,
						onContextMenu: (ev) => {
							if (typeof onMenu !== "function") return;
							ev.preventDefault();
							onMenu({ x: ev.clientX, y: ev.clientY, item });
						},
						title: "点击展开会话内命中;右键跳转到该会话",
						style: {
							display: "block",
							width: "100%",
							textAlign: "left",
							background: "transparent",
							border: "none",
							color: "inherit",
							cursor: "pointer",
							padding: "10px 4px",
						},
					},
					e(
						"div",
						{ style: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" } },
						e("span", { style: { fontWeight: 600, fontSize: 13 } }, (typeof item.title === "string" && item.title ? item.title : "(无标题会话)")),
						e("span", { style: { fontSize: 11, opacity: 0.55, whiteSpace: "nowrap" } }, formatTime(item.createdAt)),
					),
					e(
						"div",
						{ style: { fontSize: 12, opacity: 0.8, marginTop: 4 } },
						item.snippet ? highlight(item.snippet, query) : "(无内容片段)",
					),
					e(
						"div",
						{ style: { fontSize: 11, opacity: 0.5, marginTop: 4, display: "flex", gap: 8 } },
						item.live ? e("span", { key: "live" }, "进行中") : null,
						item.persisted ? e("span", { key: "p" }, "已持久化") : null,
						e(
							"span",
							{
								key: "jump",
								onClick: (ev) => {
									ev.stopPropagation();
									if (typeof onJump === "function") onJump(item.id);
								},
								style: { cursor: "pointer", textDecoration: "underline", opacity: 0.9 },
							},
							"跳转到会话",
						),
						e("span", { key: "hint" }, expanded ? "收起会话内命中" : "查看会话内命中"),
					),
				),
				expanded
					? error !== null
						? e("div", { style: { color: "#d33", fontSize: 12, padding: "0 4px 10px" } }, error)
						: events === undefined
							? e("div", { style: { fontSize: 12, opacity: 0.6, padding: "0 4px 10px" } }, "加载中…")
							: events.length === 0
								? e("div", { style: { fontSize: 12, opacity: 0.6, padding: "0 4px 10px" } }, "该会话内容中没有更多命中")
								: e(
									"ul",
									{ style: { listStyle: "none", margin: "0 0 10px", padding: "0 4px", display: "grid", gap: 6 } },
									events.map((hit, index) =>
										e(
											"li",
											{
												key: hit.seq ?? index,
												style: {
													fontSize: 12,
													opacity: 0.85,
													padding: "6px 8px",
													borderRadius: 6,
													background: "rgba(127,127,127,0.1)",
												},
											},
											e("div", { style: { fontSize: 10, opacity: 0.55, marginBottom: 2 } }, `#${hit.seq} · ${hit.type}`),
											highlight(hit.snippet, query),
										),
									),
								)
					: null,
			);
		}

		const AGENT_BADGE_COLORS = {
			claude: "#d97757",
			codex: "#10a37f",
			zcode: "#4f6ef7",
		};
		function AgentBadge(props) {
			const { agent } = props;
			return e(
				"span",
				{
					style: {
						fontSize: 10,
						padding: "1px 6px",
						borderRadius: 4,
						color: "#fff",
						background: AGENT_BADGE_COLORS[agent] ?? "#888",
						whiteSpace: "nowrap",
					},
				},
				(AGENT_OPTIONS.find((option) => option.id === agent) ?? { label: agent }).label,
			);
		}

		/** 外部 agent 会话命中行:标题 + 片段(可能多条)+ 来源路径;不可跳转,仅展示。 */
		function ExternalHit(props) {
			const { item, query } = props;
			return e(
				"div",
				{ style: { borderBottom: "1px solid rgba(127,127,127,0.18)", padding: "10px 4px" } },
				e(
					"div",
					{ style: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" } },
					e(
						"span",
						{ style: { display: "flex", gap: 6, alignItems: "center", minWidth: 0 } },
						e(AgentBadge, { agent: item.agent }),
						e("span", { style: { fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.title || "(无标题会话)"),
					),
					e("span", { style: { fontSize: 11, opacity: 0.55, whiteSpace: "nowrap" } }, formatTime(item.time)),
				),
				...(item.matches ?? []).map((snippet, index) =>
					e("div", { key: index, style: { fontSize: 12, opacity: 0.8, marginTop: 4 } }, highlight(snippet, query)),
				),
				item.titleMatch && (item.matches ?? []).length === 0
					? e("div", { style: { fontSize: 12, opacity: 0.6, marginTop: 4 } }, "(标题命中)")
					: null,
				e(
					"div",
					{ style: { fontSize: 10, opacity: 0.45, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" } },
					item.path ?? "",
				),
			);
		}

		/** 结果行右键菜单:跳转到会话。 */
		function JumpMenu(props) {
			const { menu, onClose, onJump } = props;
			react.useEffect(() => {
				const close = () => onClose();
				window.addEventListener("click", close);
				window.addEventListener("resize", close);
				return () => {
					window.removeEventListener("click", close);
					window.removeEventListener("resize", close);
				};
			}, [onClose]);
			return e(
				"div",
				{
					onClick: (ev) => ev.stopPropagation(),
					style: {
						position: "fixed",
						left: Math.min(menu.x, window.innerWidth - 190),
						top: Math.min(menu.y, window.innerHeight - 60),
						zIndex: 10001,
						minWidth: 160,
						padding: 4,
						borderRadius: 8,
						border: "1px solid color-mix(in srgb, CanvasText 22%, transparent)",
						background: "Canvas",
						color: "CanvasText",
						boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
					},
				},
				e(
					"button",
					{
						onClick: () => {
							onClose();
							if (typeof onJump === "function") onJump(menu.item.id);
						},
						style: {
							display: "block",
							width: "100%",
							textAlign: "left",
							fontSize: 13,
							padding: "7px 10px",
							border: "none",
							borderRadius: 6,
							background: "transparent",
							color: "inherit",
							cursor: "pointer",
						},
					},
					"跳转到该会话",
				),
			);
		}

		/** 全局弹层(shell.overlay 槽位,关闭时渲染 null)。 */
		function SearchOverlay(props) {
			const onJump = props && props.onJump;
			const open = react.useSyncExternalStore(subscribeOpen, () => openState.open);
			const [menu, setMenu] = react.useState(null);
			const [selectedAgents, setSelectedAgents] = react.useState(loadSelectedAgents);
			react.useEffect(() => {
				if (open) setSelectedAgents(loadSelectedAgents());
			}, [open]);
			const toggleAgent = (id) => {
				setSelectedAgents((previous) => {
					const next = previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id];
					saveSelectedAgents(next);
					return next;
				});
			};
			const [query, setQuery] = react.useState("");
			const [result, setResult] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState(null);
			const inputRef = react.useRef(null);

			react.useEffect(() => {
				if (!open) return;
				setQuery(openState.initialQuery);
				const timer = window.setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
				const onKey = (ev) => {
					if (ev.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => {
					window.clearTimeout(timer);
					window.removeEventListener("keydown", onKey);
				};
			}, [open]);

			if (!open) return null;

			const submit = async (ev) => {
				ev && ev.preventDefault();
				const trimmed = query.trim();
				if (!trimmed || loading) return;
				setLoading(true);
				setError(null);
				try {
					const payload = await runSearch({ query: trimmed, limit: 20, agents: selectedAgents });
					setResult(payload);
				} catch (cause) {
					setResult(null);
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setLoading(false);
				}
			};

			const sessions = result && result.mode === "sessions" ? result.sessions : [];

			return e(
				"div",
				{
					onClick: () => setOpen(false),
					style: {
						position: "fixed",
						inset: 0,
						zIndex: 10000,
						display: "flex",
						alignItems: "flex-start",
						justifyContent: "center",
						paddingTop: "12vh",
						background: "rgba(0,0,0,0.35)",
						backdropFilter: "blur(2px)",
					},
				},
				e(
					"div",
					{
						onClick: (ev) => ev.stopPropagation(),
						role: "dialog",
						"aria-label": "高级搜索",
						style: {
							width: "min(680px, calc(100vw - 48px))",
							maxHeight: "70vh",
							display: "flex",
							flexDirection: "column",
							borderRadius: 12,
							border: "1px solid rgba(127,127,127,0.3)",
							background: "Canvas",
							color: "CanvasText",
							boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
							overflow: "hidden",
						},
					},
					e(
						"form",
						{ onSubmit: submit, style: { display: "flex", gap: 8, padding: 12, borderBottom: "1px solid rgba(127,127,127,0.18)" } },
						e("input", {
							ref: inputRef,
							value: query,
							onChange: (ev) => setQuery(ev.target.value),
							placeholder: "输入关键字,搜索所有会话的名称与内容…",
							"aria-label": "搜索关键字",
							style: {
								flex: 1,
								fontSize: 14,
								padding: "8px 10px",
								borderRadius: 8,
								border: "1px solid rgba(127,127,127,0.35)",
								background: "transparent",
								color: "inherit",
								outline: "none",
							},
						}),
						e(
							"button",
							{
								type: "submit",
								disabled: loading,
								style: {
									fontSize: 13,
									padding: "8px 14px",
									borderRadius: 8,
									border: "none",
									cursor: loading ? "default" : "pointer",
									opacity: loading ? 0.6 : 1,
								},
							},
							loading ? "搜索中…" : "搜索",
						),
						e(
							"button",
							{
								type: "button",
								onClick: () => setOpen(false),
								"aria-label": "关闭",
								style: {
									fontSize: 13,
									padding: "8px 10px",
									borderRadius: 8,
									border: "1px solid rgba(127,127,127,0.35)",
									background: "transparent",
									color: "inherit",
									cursor: "pointer",
								},
							},
							"关闭",
						),
					),
					e(
						"div",
						{
							style: {
								display: "flex",
								gap: 14,
								alignItems: "center",
								padding: "8px 14px",
								borderBottom: "1px solid rgba(127,127,127,0.18)",
								fontSize: 12,
							},
						},
						e("span", { style: { opacity: 0.55 } }, "同时搜索:"),
						AGENT_OPTIONS.map((option) =>
							e(
								"label",
								{
									key: option.id,
									style: { display: "flex", gap: 4, alignItems: "center", cursor: "pointer", userSelect: "none" },
								},
								e("input", {
									type: "checkbox",
									checked: selectedAgents.includes(option.id),
									onChange: () => toggleAgent(option.id),
								}),
								option.label,
							),
						),
					),
					e(
						"div",
						{ style: { overflowY: "auto", padding: "4px 12px 12px", flex: 1 } },
						error !== null
							? e("div", { style: { color: "#d33", fontSize: 13, padding: "12px 4px" } }, error)
							: result === null
								? e("div", { style: { fontSize: 13, opacity: 0.6, padding: "12px 4px" } }, "输入关键字后回车,按会话搜索全部历史(标题 + 内容)。")
								: sessions.length === 0 && (result.external ?? []).length === 0
									? e("div", { style: { fontSize: 13, opacity: 0.6, padding: "12px 4px" } }, `没有找到与「${result.query}」相关的会话。`)
									: e(
										"div",
										{},
										menu !== null
											? e(JumpMenu, {
												key: "menu",
												menu,
												onClose: () => setMenu(null),
												onJump,
											})
											: null,
										e(
											"div",
											{ style: { fontSize: 12, opacity: 0.55, padding: "8px 4px" } },
											`共 ${sessions.length} 个 DSH 会话` + ((result.external ?? []).length > 0 ? `、${result.external.length} 个外部 Agent 会话命中「${result.query}」` : `命中「${result.query}」`),
										),
										(result.external ?? []).map((item) =>
											e(ExternalHit, { key: item.agent + ":" + item.id, item, query: result.query }),
										),
										sessions.map((item) =>
											e(SessionHits, {
												key: item.id,
												item,
												query: result.query,
												onJump,
												onMenu: setMenu,
											}),
										),
									),
					),
				),
			);
		}

		/** 客户端插件入口:注册按钮与弹层。 */
		const inject = ["slots", "uiWorkspace"];
		function apply(ctx) {
			const uiWorkspace = ctx.uiWorkspace;
			const jumpToSession = (sessionId) => {
				try {
					uiWorkspace.openSession(sessionId);
				} catch (error) {
					console.error("[advancesearch] 跳转会话失败:", error);
					return;
				}
				setOpen(false);
			};
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register({ name: "sidebar.footer.action", id: "advancesearch-button" }, SearchButton),
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{ name: "shell.overlay", id: "advancesearch-overlay", inject: () => ({ onJump: jumpToSession }) },
					SearchOverlay,
				),
			);
		}
		//#endregion
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
