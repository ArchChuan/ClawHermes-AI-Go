# Obsidian MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 WSL Linux 安装 Obsidian AppImage，构建 obsidian-mcp-server 接入 Claude Code，实现 session 日志/开发工具输出自动写入 vault、vault 按需检索、高价值知识半自动沉淀。

**Architecture:** obsidian-mcp-server 作为 MCP stdio server 暴露 5 个工具（vault_read/write/append/search/list），优先调用 Obsidian Local REST API（port 27123），失败降级为直接文件操作。Claude Code 通过 Stop hook 写 session 日志，通过 PostToolUse hook 捕获 go test/vet 输出，通过 MCP 工具按需检索 vault。

**Tech Stack:** Node.js 24、MCP stdio protocol、Obsidian Local REST API、bash hooks、~/.claude/settings.json

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `~/.claude/mcp/obsidian-mcp-server/package.json` | 新建 | 依赖声明（无第三方依赖） |
| `~/.claude/mcp/obsidian-mcp-server/index.js` | 新建 | MCP stdio 入口，工具注册与分发 |
| `~/.claude/mcp/obsidian-mcp-server/obsidian-client.js` | 新建 | REST API 封装 + 文件系统降级 |
| `~/.claude/mcp/obsidian-mcp-server/tools/vault_read.js` | 新建 | 读取 vault 文件 |
| `~/.claude/mcp/obsidian-mcp-server/tools/vault_write.js` | 新建 | 写入 vault 文件（覆盖） |
| `~/.claude/mcp/obsidian-mcp-server/tools/vault_append.js` | 新建 | 追加内容到 vault 文件 |
| `~/.claude/mcp/obsidian-mcp-server/tools/vault_search.js` | 新建 | 全文搜索 vault |
| `~/.claude/mcp/obsidian-mcp-server/tools/vault_list.js` | 新建 | 列出 vault 目录 |
| `~/.claude/mcp/obsidian-mcp-server/test.js` | 新建 | 集成测试（直接运行验证） |
| `~/.claude/settings.json` | 修改 | 注册 MCP server + 更新 hooks |
| `~/.claude/CLAUDE.md` | 修改 | 补充知识沉淀触发规则 |

---

## Task 1: 安装 Obsidian AppImage

**Files:**

- 新建: `~/bin/obsidian.sh`（启动脚本）

- [ ] **Step 1: 下载最新 Obsidian AppImage**

```bash
mkdir -p ~/bin ~/obsidian-vault
wget -O ~/bin/Obsidian.AppImage \
  "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.8.10/Obsidian-1.8.10.AppImage"
chmod +x ~/bin/Obsidian.AppImage
```

- [ ] **Step 2: 安装 FUSE（AppImage 依赖）**

```bash
sudo apt-get install -y libfuse2 libglib2.0-0 libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2
```

- [ ] **Step 3: 创建启动脚本**

```bash
cat > ~/bin/obsidian.sh << 'EOF'
#!/bin/bash
export DISPLAY=${DISPLAY:-:0}
export WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
exec ~/bin/Obsidian.AppImage --no-sandbox "$@" &
EOF
chmod +x ~/bin/obsidian.sh
```

- [ ] **Step 4: 首次启动 Obsidian，打开 vault**

```bash
~/bin/obsidian.sh
```

在 Obsidian GUI 中选择 "Open folder as vault"，选择 `~/obsidian-vault`。

- [ ] **Step 5: 安装 Local REST API 插件**

在 Obsidian 中：

1. Settings → Community plugins → Browse
2. 搜索 "Local REST API"，安装并启用
3. 插件设置中复制 API Key（形如 `abc123...`）
4. 记录端口（默认 27123）

- [ ] **Step 6: 验证 REST API 可用**

```bash
API_KEY="<从插件设置复制的key>"
curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:27123/vault/ | head -20
```

预期：返回 JSON `{"files": [...]}` 格式的 vault 根目录列表。

- [ ] **Step 7: 配置环境变量**

```bash
cat >> ~/.bashrc << 'EOF'
export VAULT_PATH="$HOME/obsidian-vault"
export OBSIDIAN_API_KEY="<你的API_KEY>"
export OBSIDIAN_REST_PORT="27123"
EOF
source ~/.bashrc
```

---

## Task 2: 创建 obsidian-mcp-server 基础骨架

**Files:**

- 新建: `~/.claude/mcp/obsidian-mcp-server/package.json`
- 新建: `~/.claude/mcp/obsidian-mcp-server/obsidian-client.js`

- [ ] **Step 1: 创建目录和 package.json**

```bash
mkdir -p ~/.claude/mcp/obsidian-mcp-server/tools
```

写入 `~/.claude/mcp/obsidian-mcp-server/package.json`：

```json
{
  "name": "obsidian-mcp-server",
  "version": "1.0.0",
  "type": "commonjs",
  "main": "index.js",
  "dependencies": {}
}
```

- [ ] **Step 2: 创建 obsidian-client.js（REST + 文件系统降级）**

写入 `~/.claude/mcp/obsidian-mcp-server/obsidian-client.js`：

```js
const fs = require('fs');
const path = require('path');
const http = require('http');

const VAULT_PATH = process.env.VAULT_PATH || path.join(process.env.HOME, 'obsidian-vault');
const API_KEY = process.env.OBSIDIAN_API_KEY || '';
const PORT = parseInt(process.env.OBSIDIAN_REST_PORT || '27123', 10);
const BASE_URL = `http://localhost:${PORT}`;

function restRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: endpoint,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function absPath(vaultRelPath) {
  return path.join(VAULT_PATH, vaultRelPath);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function readFile(vaultPath) {
  try {
    const r = await restRequest('GET', `/vault/${encodeURIComponent(vaultPath)}`);
    if (r.status === 200) return r.body;
  } catch {}
  return fs.readFileSync(absPath(vaultPath), 'utf8');
}

async function writeFile(vaultPath, content) {
  try {
    const r = await restRequest('PUT', `/vault/${encodeURIComponent(vaultPath)}`, { content });
    if (r.status === 200 || r.status === 204) return { ok: true };
  } catch {}
  const p = absPath(vaultPath);
  ensureDir(p);
  fs.writeFileSync(p, content, 'utf8');
  return { ok: true };
}

async function appendFile(vaultPath, content) {
  try {
    const r = await restRequest('POST', `/vault/${encodeURIComponent(vaultPath)}`, { content });
    if (r.status === 200 || r.status === 204) return { ok: true };
  } catch {}
  const p = absPath(vaultPath);
  ensureDir(p);
  fs.appendFileSync(p, content, 'utf8');
  return { ok: true };
}

async function searchFiles(query, limit = 10) {
  try {
    const r = await restRequest('POST', `/search/simple/?query=${encodeURIComponent(query)}&contextLength=200`);
    if (r.status === 200) {
      const results = JSON.parse(r.body);
      return results.slice(0, limit).map(r => ({ path: r.filename, excerpt: r.context }));
    }
  } catch {}
  // 降级：grep 文件系统
  const results = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (f.endsWith('.md')) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          const idx = content.toLowerCase().indexOf(query.toLowerCase());
          results.push({
            path: path.relative(VAULT_PATH, full),
            excerpt: content.slice(Math.max(0, idx - 100), idx + 200),
          });
        }
      }
    }
  }
  walk(VAULT_PATH);
  return results.slice(0, limit);
}

async function listFiles(vaultPath = '') {
  try {
    const endpoint = vaultPath ? `/vault/${encodeURIComponent(vaultPath)}/` : '/vault/';
    const r = await restRequest('GET', endpoint);
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      return (data.files || []).map(f => ({ path: f, mtime: null }));
    }
  } catch {}
  const dir = absPath(vaultPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(f => {
    const full = path.join(dir, f);
    return { path: path.join(vaultPath, f), mtime: fs.statSync(full).mtime.toISOString() };
  });
}

module.exports = { readFile, writeFile, appendFile, searchFiles, listFiles };
```

- [ ] **Step 3: 验证模块可加载**

```bash
cd ~/.claude/mcp/obsidian-mcp-server
node -e "const c = require('./obsidian-client'); console.log(Object.keys(c))"
```

预期：`[ 'readFile', 'writeFile', 'appendFile', 'searchFiles', 'listFiles' ]`

---

## Task 3: 实现五个 MCP 工具模块

**Files:**

- 新建: `~/.claude/mcp/obsidian-mcp-server/tools/vault_read.js`
- 新建: `~/.claude/mcp/obsidian-mcp-server/tools/vault_write.js`
- 新建: `~/.claude/mcp/obsidian-mcp-server/tools/vault_append.js`
- 新建: `~/.claude/mcp/obsidian-mcp-server/tools/vault_search.js`
- 新建: `~/.claude/mcp/obsidian-mcp-server/tools/vault_list.js`

- [ ] **Step 1: 写 vault_read.js**

```js
const client = require('../obsidian-client');

const schema = {
  name: 'vault_read',
  description: '读取 Obsidian vault 中的文件内容',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'vault 内相对路径，如 knowledge/bugs/xxx.md' },
    },
    required: ['path'],
  },
};

async function handle(args) {
  const content = await client.readFile(args.path);
  return { content: [{ type: 'text', text: content }] };
}

module.exports = { schema, handle };
```

写入 `~/.claude/mcp/obsidian-mcp-server/tools/vault_read.js`。

- [ ] **Step 2: 写 vault_write.js**

```js
const client = require('../obsidian-client');

const schema = {
  name: 'vault_write',
  description: '覆盖写入 Obsidian vault 文件（不存在则创建）',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'vault 内相对路径' },
      content: { type: 'string', description: '文件完整内容（Markdown）' },
    },
    required: ['path', 'content'],
  },
};

async function handle(args) {
  const result = await client.writeFile(args.path, args.content);
  return { content: [{ type: 'text', text: result.ok ? 'ok' : 'error' }] };
}

module.exports = { schema, handle };
```

写入 `~/.claude/mcp/obsidian-mcp-server/tools/vault_write.js`。

- [ ] **Step 3: 写 vault_append.js**

```js
const client = require('../obsidian-client');

const schema = {
  name: 'vault_append',
  description: '向 Obsidian vault 文件末尾追加内容（不存在则创建）',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'vault 内相对路径' },
      content: { type: 'string', description: '追加的内容（Markdown）' },
    },
    required: ['path', 'content'],
  },
};

async function handle(args) {
  const result = await client.appendFile(args.path, args.content);
  return { content: [{ type: 'text', text: result.ok ? 'ok' : 'error' }] };
}

module.exports = { schema, handle };
```

写入 `~/.claude/mcp/obsidian-mcp-server/tools/vault_append.js`。

- [ ] **Step 4: 写 vault_search.js**

```js
const client = require('../obsidian-client');

const schema = {
  name: 'vault_search',
  description: '在 Obsidian vault 中全文搜索笔记',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '最多返回条数，默认 10', default: 10 },
    },
    required: ['query'],
  },
};

async function handle(args) {
  const results = await client.searchFiles(args.query, args.limit || 10);
  const text = results.length === 0
    ? '未找到匹配内容'
    : results.map(r => `### ${r.path}\n${r.excerpt}`).join('\n\n');
  return { content: [{ type: 'text', text }] };
}

module.exports = { schema, handle };
```

写入 `~/.claude/mcp/obsidian-mcp-server/tools/vault_search.js`。

- [ ] **Step 5: 写 vault_list.js**

```js
const client = require('../obsidian-client');

const schema = {
  name: 'vault_list',
  description: '列出 Obsidian vault 目录下的文件',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'vault 内目录路径，默认为根目录', default: '' },
    },
    required: [],
  },
};

async function handle(args) {
  const files = await client.listFiles(args.path || '');
  const text = files.length === 0
    ? '（空目录）'
    : files.map(f => `${f.path}${f.mtime ? `  [${f.mtime}]` : ''}`).join('\n');
  return { content: [{ type: 'text', text }] };
}

module.exports = { schema, handle };
```

写入 `~/.claude/mcp/obsidian-mcp-server/tools/vault_list.js`。

---

## Task 4: 实现 MCP stdio 入口 index.js

**Files:**

- 新建: `~/.claude/mcp/obsidian-mcp-server/index.js`

- [ ] **Step 1: 写 index.js**

```js
const readline = require('readline');
const tools = [
  require('./tools/vault_read'),
  require('./tools/vault_write'),
  require('./tools/vault_append'),
  require('./tools/vault_search'),
  require('./tools/vault_list'),
];
const toolMap = Object.fromEntries(tools.map(t => [t.schema.name, t]));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'obsidian-mcp-server', version: '1.0.0' },
      },
    });
  }
  if (msg.method === 'tools/list') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: tools.map(t => t.schema) },
    });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    const tool = toolMap[name];
    if (!tool) {
      return send({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
    }
    try {
      const result = await tool.handle(args || {});
      return send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      return send({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32000, message: err.message },
      });
    }
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.id != null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`Parse error: ${e.message}\n`);
  }
});
```

写入 `~/.claude/mcp/obsidian-mcp-server/index.js`。

- [ ] **Step 2: 冒烟测试 MCP 协议**

```bash
cd ~/.claude/mcp/obsidian-mcp-server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | node index.js
```

预期：输出包含 `"serverInfo":{"name":"obsidian-mcp-server"` 的 JSON。

- [ ] **Step 3: 验证 tools/list**

```bash
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'; echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}') | node index.js
```

预期：第二条响应中包含 `vault_read`、`vault_write`、`vault_append`、`vault_search`、`vault_list` 五个工具。

---

## Task 5: 集成测试（文件系统降级路径）

**Files:**

- 新建: `~/.claude/mcp/obsidian-mcp-server/test.js`

- [ ] **Step 1: 写 test.js**

```js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 使用临时目录作为 vault
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-test-'));
process.env.VAULT_PATH = tmpVault;
process.env.OBSIDIAN_API_KEY = '';
process.env.OBSIDIAN_REST_PORT = '19999'; // 不存在的端口，强制降级

const client = require('./obsidian-client');

async function run() {
  // vault_write + vault_read
  await client.writeFile('test/hello.md', '# Hello\nworld');
  const content = await client.readFile('test/hello.md');
  assert.ok(content.includes('Hello'), 'readFile should return written content');

  // vault_append
  await client.appendFile('test/hello.md', '\n## Appended');
  const after = await client.readFile('test/hello.md');
  assert.ok(after.includes('Appended'), 'appendFile should append content');

  // vault_search
  const results = await client.searchFiles('Appended');
  assert.ok(results.length > 0, 'searchFiles should find appended content');
  assert.ok(results[0].path.includes('hello.md'), 'searchFiles result path should match');

  // vault_list
  const files = await client.listFiles('test');
  assert.ok(files.some(f => f.path.includes('hello.md')), 'listFiles should list the file');

  // 清理
  fs.rmSync(tmpVault, { recursive: true });
  console.log('All tests passed.');
}

run().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
```

写入 `~/.claude/mcp/obsidian-mcp-server/test.js`。

- [ ] **Step 2: 运行测试**

```bash
cd ~/.claude/mcp/obsidian-mcp-server
node test.js
```

预期：`All tests passed.`

- [ ] **Step 3: Commit**

```bash
git -C ~/.claude add mcp/obsidian-mcp-server/ 2>/dev/null || true
# settings.json 由下一个 task 更新后一起提交
echo "MCP server files ready"
```

---

## Task 6: 注册 MCP server 到 Claude Code

**Files:**

- 修改: `~/.claude/settings.json`

- [ ] **Step 1: 读取当前 settings.json mcpServers 字段**

```bash
cat ~/.claude/settings.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('mcpServers',{}), indent=2))"
```

- [ ] **Step 2: 添加 obsidian-mcp-server 到 mcpServers**

用 update-config skill 或直接用 python3 更新：

```bash
python3 << 'EOF'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
with open(p) as f:
    d = json.load(f)
d.setdefault('mcpServers', {})['obsidian'] = {
    "type": "stdio",
    "command": "node",
    "args": [os.path.expanduser("~/.claude/mcp/obsidian-mcp-server/index.js")],
    "env": {
        "VAULT_PATH": os.path.expanduser("~/obsidian-vault"),
        "OBSIDIAN_API_KEY": os.environ.get("OBSIDIAN_API_KEY", ""),
        "OBSIDIAN_REST_PORT": "27123"
    }
}
with open(p, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print("Done")
EOF
```

- [ ] **Step 3: 验证配置写入**

```bash
cat ~/.claude/settings.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['mcpServers'].get('obsidian',{}), indent=2))"
```

预期：输出包含 `"command": "node"` 和正确路径。

- [ ] **Step 4: 重启 Claude Code，验证 MCP 工具可用**

重启 Claude Code 会话后，运行：

```
使用 vault_list 列出 vault 根目录
```

预期：返回 vault 目录内容（或空目录提示）。

---

## Task 7: 更新 Stop hook（session 日志写 vault）

**Files:**

- 修改: `~/.claude/settings.json`

- [ ] **Step 1: 在 Stop hook 追加 vault_append 命令**

当前 Stop hook 已有 `claude-mem summarize` 命令。追加一条写 vault 的命令：

```bash
python3 << 'EOF'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
with open(p) as f:
    d = json.load(f)

new_hook = {
    "type": "command",
    "command": (
        'bash -c \''
        'DATE=$(date +%Y-%m-%d); '
        'PROJECT=$(basename "$PWD"); '
        'VAULT="$HOME/obsidian-vault"; '
        'SUMMARY=$(bash ~/.claude/claude-mem-hook.sh hook claude-code summarize 2>&1 | tail -5); '
        'NOTE="## Session $(date +%H:%M)\\n\\n**Project:** $PROJECT\\n\\n$SUMMARY\\n\\n---\\n"; '
        'mkdir -p "$VAULT/claude-mem/sessions"; '
        'printf "%b" "$NOTE" >> "$VAULT/claude-mem/sessions/$DATE.md"\''
    ),
    "timeout": 30
}

hooks = d.setdefault('hooks', {})
stop_hooks = hooks.setdefault('Stop', [{}])
stop_hooks[0].setdefault('hooks', []).append(new_hook)

with open(p, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print("Done")
EOF
```

- [ ] **Step 2: 验证 hook 追加成功**

```bash
cat ~/.claude/settings.json | python3 -c "
import sys,json; d=json.load(sys.stdin)
stop = d['hooks']['Stop'][0]['hooks']
print(f'Stop hooks count: {len(stop)}')
print('Last hook command preview:', stop[-1]['command'][:80])
"
```

预期：`Stop hooks count: 3`，最后一条包含 `obsidian-vault`。

- [ ] **Step 3: 手动触发测试**

```bash
bash -c '
DATE=$(date +%Y-%m-%d)
PROJECT=$(basename "$PWD")
VAULT="$HOME/obsidian-vault"
NOTE="## Session TEST $(date +%H:%M)\n\n**Project:** $PROJECT\n\nTest entry.\n\n---\n"
mkdir -p "$VAULT/claude-mem/sessions"
printf "%b" "$NOTE" >> "$VAULT/claude-mem/sessions/$DATE.md"
echo "Written to: $VAULT/claude-mem/sessions/$DATE.md"
'
```

预期：打印写入路径，文件存在且有内容。

```bash
cat ~/obsidian-vault/claude-mem/sessions/$(date +%Y-%m-%d).md
```

---

## Task 8: 更新 PostToolUse hook（go test/vet 输出写 vault）

**Files:**

- 修改: `~/.claude/settings.json`

- [ ] **Step 1: 添加 Bash PostToolUse hook 捕获 go test/vet**

```bash
python3 << 'EOF'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
with open(p) as f:
    d = json.load(f)

new_hook_entry = {
    "matcher": "Bash",
    "hooks": [{
        "type": "command",
        "command": (
            'bash -c \''
            'INPUT=$(cat); '
            'CMD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\"tool_input\",{}).get(\"command\",\"\"))" 2>/dev/null); '
            'if echo "$CMD" | grep -qE "^go (test|vet)"; then '
            '  DATE=$(date +%Y-%m-%d); '
            '  PROJECT=$(basename "$PWD"); '
            '  VAULT="$HOME/obsidian-vault"; '
            '  OUTPUT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\"tool_response\",{}).get(\"output\",\"\"))" 2>/dev/null | head -50); '
            '  NOTE="## $CMD\\n\\n$(date +%H:%M)\\n\\n\`\`\`\\n$OUTPUT\\n\`\`\`\\n\\n---\\n"; '
            '  mkdir -p "$VAULT/dev-logs/$PROJECT"; '
            '  printf "%b" "$NOTE" >> "$VAULT/dev-logs/$PROJECT/$DATE.md"; '
            'fi\''
        ),
        "async": True
    }]
}

hooks = d.setdefault('hooks', {})
post = hooks.setdefault('PostToolUse', [])
post.append(new_hook_entry)

with open(p, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print("Done")
EOF
```

- [ ] **Step 2: 验证配置**

```bash
cat ~/.claude/settings.json | python3 -c "
import sys,json; d=json.load(sys.stdin)
post = d['hooks']['PostToolUse']
bash_hooks = [h for h in post if h.get('matcher') == 'Bash']
print(f'Bash PostToolUse hooks: {len(bash_hooks)}')
"
```

预期：`Bash PostToolUse hooks: 1`

- [ ] **Step 3: 手动测试写入路径**

```bash
# 在 ClawHermes-AI-Go 目录下运行
cd /home/yang/go-projects/ClawHermes-AI-Go
go test -short ./... 2>&1 | head -20
cat ~/obsidian-vault/dev-logs/ClawHermes-AI-Go/$(date +%Y-%m-%d).md 2>/dev/null || echo "file not yet created (hook is async)"
```

---

## Task 9: 补充 CLAUDE.md 知识沉淀触发规则

**Files:**

- 修改: `~/.claude/CLAUDE.md`

- [ ] **Step 1: 在 CLAUDE.md 末尾追加知识沉淀规则**

在 `~/.claude/CLAUDE.md` 末尾追加以下内容：

```markdown

## 知识沉淀规则（Obsidian vault）

在对话中识别到以下四类高价值内容时，**必须提示用户确认**后再调用 `vault_write` 写入 vault。提示格式：

> "这段内容值得沉淀到知识库 → `knowledge/bugs/2026-06-09-xxx.md`，确认写入？"

| 类别 | 识别信号 | vault 路径 |
|------|---------|-----------|
| 问题解决 | 排查 bug、错误修复、踩坑记录 | `knowledge/bugs/YYYY-MM-DD-<title>.md` |
| 架构决策 | 技术选型讨论、why not X 理由 | `knowledge/decisions/YYYY-MM-DD-<title>.md` |
| 代码知识 | 接口约定、模块设计意图、边界条件 | `knowledge/code/MODULE-<title>.md` |
| 代码片段 | 可复用工具函数、配置模板 | `knowledge/snippets/LANG-<title>.md` |

拒绝则跳过，不重复提示。vault 可随时通过 `vault_search` 按需检索。
```

- [ ] **Step 2: 验证追加**

```bash
tail -20 ~/.claude/CLAUDE.md
```

预期：包含"知识沉淀规则"章节。

---

## Task 10: 端到端验证

- [ ] **Step 1: 重启 Claude Code 会话**

完全退出并重新启动 Claude Code，确保新 MCP server 和 hooks 生效。

- [ ] **Step 2: 验证 MCP 工具注册**

在新会话中输入：`使用 vault_list 列出 obsidian vault 根目录`

预期：返回目录内容（应有 `claude-mem/` 目录）。

- [ ] **Step 3: 验证 vault_write 写入知识**

在新会话中输入：`用 vault_write 写一条测试笔记到 knowledge/test/hello.md，内容是"# Test\nHello vault"`

预期：工具调用成功，`~/obsidian-vault/knowledge/test/hello.md` 存在。

```bash
cat ~/obsidian-vault/knowledge/test/hello.md
```

- [ ] **Step 4: 验证 vault_search 检索**

在新会话中输入：`用 vault_search 搜索 "Hello vault"`

预期：返回 `knowledge/test/hello.md` 及摘要。

- [ ] **Step 5: 在 Obsidian GUI 中确认笔记可见**

```bash
~/bin/obsidian.sh
```

在 Obsidian 中打开 `knowledge/test/hello.md`，确认内容正确显示。
