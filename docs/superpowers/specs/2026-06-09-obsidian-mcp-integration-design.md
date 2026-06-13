# Obsidian MCP Integration Design

Date: 2026-06-09

## 目标

在 WSL Linux 中安装 Obsidian（AppImage + X11），通过自定义 MCP server 将 Obsidian vault 接入 Claude Code，与 claude-mem 形成分工：

- claude-mem：跨会话记忆压缩与检索
- Obsidian vault：可读存档 + 本地开发工具输出落库 + 按需知识查询 + 长期知识沉淀

## 架构

```
WSL Linux
├── Obsidian AppImage (X11/Wayland GUI)
│   └── Local REST API plugin (port 27123)
├── obsidian-mcp-server (~/.claude/mcp/obsidian-mcp-server/)
│   ├── index.js              ← MCP stdio 入口
│   ├── obsidian-client.js    ← REST API 封装 + 文件系统降级
│   └── tools/
│       ├── vault_read.js
│       ├── vault_write.js
│       ├── vault_append.js
│       ├── vault_search.js
│       └── vault_list.js
├── claude-mem MCP server (已有，mcp-search)
└── Claude Code
    ├── MCP: obsidian-mcp-server (新增)
    ├── MCP: mcp-search (claude-mem 已有)
    └── Hooks
        ├── Stop → claude-mem summarize + vault_append session 日志
        └── PostToolUse(Bash, go test/vet) → vault_append dev-logs
```

## 知识沉淀（半自动）

Claude Code 在对话过程中识别以下四类高价值内容，**提示用户确认后**写入 vault：

| 类别 | 识别信号 | vault 路径 |
|------|---------|-----------|
| **问题解决** | 排查 bug、错误修复、踩坑记录 | `knowledge/bugs/YYYY-MM-DD-<title>.md` |
| **架构决策** | 技术选型讨论、why not X 的理由 | `knowledge/decisions/YYYY-MM-DD-<title>.md` |
| **代码知识** | 接口约定、模块设计意图、边界条件 | `knowledge/code/MODULE-<title>.md` |
| **代码片段** | 可复用的工具函数、配置模板 | `knowledge/snippets/LANG-<title>.md` |

**确认流程**：识别到高价值内容时，Claude 提示：
> "这段内容值得沉淀到知识库 → `knowledge/bugs/2026-06-09-xxx.md`，确认写入？"

用户批准后调用 `vault_write` MCP tool。拒绝则跳过，不再重复提示。

新增 MCP 工具：

| 工具 | 参数 | 返回 |
|------|------|------|
| `vault_list` | `path?: string` | `[{path, mtime}]`（列目录） |

## 数据分流

| 方向 | 触发 | vault 路径 |
|------|------|-----------|
| session 观测 → vault | Stop hook | `claude-mem/sessions/YYYY-MM-DD.md` |
| go test/vet 输出 → vault | PostToolUse hook | `dev-logs/PROJECT/YYYY-MM-DD.md` |
| 高价值知识 → vault | 半自动（用户确认） | `knowledge/<类别>/` |
| vault → Claude Code | 主动调用 vault_search | 按需检索，不注入上下文 |

## MCP 工具

| 工具 | 参数 | 返回 |
|------|------|------|
| `vault_read` | `path: string` | 文件内容字符串 |
| `vault_write` | `path: string, content: string` | `{ok: bool}` |
| `vault_append` | `path: string, content: string` | `{ok: bool}` |
| `vault_search` | `query: string, limit?: number` | `[{path, excerpt}]`（全文搜索，调用 `/search/simple`） |

## 降级策略

obsidian-client.js 优先调用 `http://localhost:27123`（Obsidian Local REST API），失败则直接操作 `VAULT_PATH` 目录。对 MCP 工具层透明。

## 安装步骤（高层）

1. 安装 Obsidian AppImage + 配置 X11 启动脚本
2. Obsidian 内安装 Local REST API 插件，记录 API key
3. 创建 obsidian-mcp-server（Node.js，~/.claude/mcp/obsidian-mcp-server/）
4. 在 ~/.claude/settings.json 注册 MCP server + 配置 VAULT_PATH / OBSIDIAN_API_KEY
5. 更新 Stop hook：追加 vault_append 调用
6. 更新 PostToolUse hook：捕获 go test/vet 输出写 vault
7. 在 CLAUDE.md 补充知识沉淀触发规则（Claude 识别信号说明）

## 环境变量

| 变量 | 说明 |
|------|------|
| `VAULT_PATH` | vault 绝对路径，如 `~/obsidian-vault` |
| `OBSIDIAN_API_KEY` | Local REST API 插件生成的 token |
| `OBSIDIAN_REST_PORT` | 默认 27123 |

## 不在范围内

- SessionStart → vault 注入（避免上下文膨胀，改为按需 vault_search）
- 外部服务同步（GitHub Issues、Notion 等）
- Obsidian 插件开发（只用 Local REST API 标准插件）
