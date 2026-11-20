const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const STATE_DIR = path.join(os.homedir(), '.snapgent');
const STATE_FILE = path.join(STATE_DIR, 'active-workspace.json');
const MAX_LOGS = 80;

let statusBarItem = null;
let sidebarProvider = null;
let socket = null;
let reconnectTimer = null;
let isDisposing = false;

const MAX_RUNS = 15;

let bridgeState = {
  connected: false,
  connecting: false,
  busy: false,
  busyText: '',
  bridgeVersion: null,
  servers: [],
  tools: [],
  toolCount: 0,
  activeTasks: [],
  recentRuns: [],
  lastSyncAt: null,
  logs: [],
};

function addLog(level, message) {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  bridgeState.logs.unshift({ time, level, message });
  if (bridgeState.logs.length > MAX_LOGS) {
    bridgeState.logs.length = MAX_LOGS;
  }
  pushSidebarState();
}

function detectIdeId() {
  const appName = String(vscode.env.appName || '').toLowerCase();
  return appName.includes('antigravity') ? 'antigravity' : 'vscode';
}

function getPrimaryWorkspacePath() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  return folders[0].uri.fsPath;
}

function getBridgePort() {
  const config = vscode.workspace.getConfiguration('snapgent');
  const port = Number(config.get('bridgePort', 17613));
  return Number.isFinite(port) && port > 0 ? port : 17613;
}

function listWorkspaceSkills() {
  const workspacePath = getPrimaryWorkspacePath();
  if (!workspacePath) {
    return [];
  }
  const skillsRoot = path.join(workspacePath, '.snapgent', 'skills');
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  try {
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        skills.push({
          name: entry.name,
          file: skillFile,
        });
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function normalizeToolList(rawTools) {
  if (!Array.isArray(rawTools)) {
    return [];
  }
  return rawTools
    .map((item) => {
      if (typeof item === 'string') {
        return { name: item, description: '' };
      }
      if (item && typeof item === 'object') {
        return {
          name: String(item.name || item.id || ''),
          description: String(item.description || ''),
        };
      }
      return null;
    })
    .filter((t) => t && t.name);
}

function pushSidebarState() {
  if (!sidebarProvider) {
    return;
  }
  sidebarProvider.postState({
    ide: detectIdeId(),
    port: getBridgePort(),
    workspace: getPrimaryWorkspacePath(),
    connected: bridgeState.connected,
    connecting: bridgeState.connecting,
    busy: bridgeState.busy,
    busyText: bridgeState.busyText,
    bridgeVersion: bridgeState.bridgeVersion,
    servers: bridgeState.servers,
    tools: bridgeState.tools,
    toolCount: bridgeState.toolCount,
    activeTasks: bridgeState.activeTasks,
    recentRuns: bridgeState.recentRuns,
    skills: listWorkspaceSkills(),
    lastSyncAt: bridgeState.lastSyncAt,
    logs: bridgeState.logs,
  });
}

function setBusy(busy, busyText = '') {
  bridgeState.busy = busy;
  bridgeState.busyText = busyText;
  updateStatusBar();
  pushSidebarState();
}

function syncActiveWorkspace(silent = true) {
  const workspacePath = getPrimaryWorkspacePath();
  if (!workspacePath) {
    addLog('warn', 'No open workspace folder to sync');
    if (!silent) {
      vscode.window.showWarningMessage('Snapgent: No open workspace folder to sync');
    }
    return false;
  }

  const payload = {
    ide: detectIdeId(),
    workspace: workspacePath,
    updated_at: Date.now(),
  };

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmpFile = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpFile, STATE_FILE);
    bridgeState.lastSyncAt = payload.updated_at;
    addLog('info', `Synced workspace: ${path.basename(workspacePath)}`);
    if (!silent) {
      vscode.window.showInformationMessage(`Snapgent: Synced workspace (${path.basename(workspacePath)})`);
    }
    return true;
  } catch (error) {
    addLog('error', `Workspace sync failed: ${error.message}`);
    if (!silent) {
      vscode.window.showErrorMessage(`Snapgent: Failed to sync workspace: ${error.message}`);
    }
    return false;
  }
}

function updateStatusBar() {
  if (!statusBarItem) {
    return;
  }
  if (bridgeState.activeTasks.length > 0) {
    const active = bridgeState.activeTasks[0];
    const suffix = bridgeState.activeTasks.length > 1 ? ` (+${bridgeState.activeTasks.length - 1})` : '';
    statusBarItem.text = `$(sync~spin) Snapgent: ${active.tool}${suffix}`;
    statusBarItem.tooltip = `Running ${active.server}/${active.tool}`;
    statusBarItem.backgroundColor = undefined;
    return;
  }
  if (bridgeState.busy || bridgeState.connecting) {
    const label = bridgeState.busyText || 'Connecting';
    statusBarItem.text = `$(sync~spin) Snapgent: ${label}`;
    statusBarItem.tooltip = `SnapgentV3 Bridge (${label})`;
    statusBarItem.backgroundColor = undefined;
    return;
  }
  if (!bridgeState.connected) {
    statusBarItem.text = '$(plug) Snapgent: Offline';
    statusBarItem.tooltip = `SnapgentV3 Bridge offline on port ${getBridgePort()}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  const ver = bridgeState.bridgeVersion ? `v${bridgeState.bridgeVersion}` : 'Connected';
  statusBarItem.text = `$(radio-tower) Snapgent: ${ver} (${bridgeState.toolCount} tools)`;
  const serverSummary = bridgeState.servers.length
    ? bridgeState.servers.map((s) => `${s.id}: ${s.alive ? `${s.tools} tools` : 'offline'}`).join('\n')
    : 'No MCP servers reported';
  statusBarItem.tooltip = `SnapgentV3 Bridge (${ver})\n${serverSummary}`;
  statusBarItem.backgroundColor = undefined;
}

function scheduleReconnect() {
  if (isDisposing || reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, 5000);
}

function sendBridgeMessage(message) {
  if (!socket || socket.readyState !== 1) {
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function connectBridge() {
  if (isDisposing) {
    return;
  }
  if (typeof WebSocket !== 'function') {
    bridgeState.connected = false;
    bridgeState.connecting = false;
    addLog('error', 'WebSocket API unavailable in this runtime');
    updateStatusBar();
    pushSidebarState();
    return;
  }
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
    return;
  }

  const port = getBridgePort();
  const url = `ws://127.0.0.1:${port}`;
  bridgeState.connecting = true;
  updateStatusBar();
  pushSidebarState();

  try {
    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener('open', () => {
      bridgeState.connected = true;
      bridgeState.connecting = false;
      addLog('info', `Connected to bridge on port ${port}`);
      updateStatusBar();
      pushSidebarState();
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data || '{}'));
        if (data.type === 'connected' || data.type === 'tools' || data.type === 'mcp_status') {
          bridgeState.connected = true;
          bridgeState.connecting = false;
          if (data.bridge_version) {
            bridgeState.bridgeVersion = data.bridge_version;
          }
          if (Array.isArray(data.servers)) {
            bridgeState.servers = data.servers;
          }
          if (Array.isArray(data.tools)) {
            bridgeState.tools = normalizeToolList(data.tools);
            bridgeState.toolCount = bridgeState.tools.length;
          }
          addLog('info', `Update (${data.type}): ${bridgeState.toolCount} tools, ${bridgeState.servers.length} servers`);
          updateStatusBar();
          pushSidebarState();
        } else if (data.type === 'tool_progress') {
          const taskId = String(data.id || `${data.tool || 'tool'}-${Date.now()}`);
          const toolName = String(data.tool || data.name || 'unknown');
          const serverName = String(data.server || 'mcp');
          const nowTime = new Date().toTimeString().slice(0, 8);
          if (data.phase === 'start') {
            bridgeState.activeTasks = bridgeState.activeTasks.filter((t) => t.id !== taskId);
            bridgeState.activeTasks.unshift({ id: taskId, tool: toolName, server: serverName, time: nowTime });
            addLog('info', `Running ${serverName}/${toolName}`);
          } else if (data.phase === 'end') {
            bridgeState.activeTasks = bridgeState.activeTasks.filter((t) => t.id !== taskId);
            const ok = Boolean(data.ok);
            const durationMs = Number.isFinite(Number(data.duration_ms)) ? Number(data.duration_ms) : 0;
            bridgeState.recentRuns.unshift({
              id: taskId,
              tool: toolName,
              server: serverName,
              ok,
              durationMs,
              time: nowTime,
            });
            if (bridgeState.recentRuns.length > MAX_RUNS) {
              bridgeState.recentRuns.length = MAX_RUNS;
            }
            addLog(ok ? 'info' : 'error', `${ok ? 'Done' : 'Failed'} ${serverName}/${toolName} (${durationMs}ms)`);
          }
          updateStatusBar();
          pushSidebarState();
        }
      } catch {
        // Ignore malformed frames
      }
    });

    ws.addEventListener('close', () => {
      if (socket === ws) {
        socket = null;
      }
      const wasConnected = bridgeState.connected;
      bridgeState.connected = false;
      bridgeState.connecting = false;
      bridgeState.activeTasks = [];
      if (wasConnected) {
        addLog('warn', 'Bridge closed; retry scheduled in 5s');
      }
      updateStatusBar();
      pushSidebarState();
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      bridgeState.connected = false;
      bridgeState.connecting = false;
      updateStatusBar();
      pushSidebarState();
    });
  } catch (error) {
    bridgeState.connected = false;
    bridgeState.connecting = false;
    addLog('error', `Connect error: ${error.message}`);
    updateStatusBar();
    pushSidebarState();
    scheduleReconnect();
  }
}

async function runWithProgress(title, task) {
  setBusy(true, title);
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Snapgent: ${title}`,
        cancellable: false,
      },
      async () => task()
    );
  } finally {
    setBusy(false, '');
  }
}

async function sendSelectionToSnapgent() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Snapgent: No active editor');
    return;
  }
  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (!selectedText.trim()) {
    vscode.window.showWarningMessage('Snapgent: Select some code first');
    return;
  }

  const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  const lang = editor.document.languageId || '';
  const formatted = `File: \`${relPath}\` (L${startLine}-L${endLine})\n\`\`\`${lang}\n${selectedText}\n\`\`\``;

  await vscode.env.clipboard.writeText(formatted);
  addLog('info', `Copied selection: ${relPath} (L${startLine}-L${endLine})`);
  vscode.window.showInformationMessage(`Snapgent: Copied ${relPath} (L${startLine}-L${endLine})`);
}

async function createNewSkill() {
  const workspacePath = getPrimaryWorkspacePath();
  if (!workspacePath) {
    vscode.window.showWarningMessage('Snapgent: Open a workspace folder to create a skill');
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Skill folder name (letters, numbers, hyphens)',
    validateInput: (val) => (/^[a-z0-9-]+$/i.test(val.trim()) ? null : 'Use letters, numbers, and hyphens only'),
  });
  if (!name) {
    return;
  }
  const skillsRoot = path.join(workspacePath, '.snapgent', 'skills');
  const dir = path.join(skillsRoot, name.trim());
  const file = path.join(dir, 'SKILL.md');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# ${name.trim()}\n\nDescribe when the AI should use this skill and what rules it must follow.\n`,
      'utf8'
    );
  }
  addLog('info', `Created skill: ${name.trim()}`);
  pushSidebarState();
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc);
}

async function openSkillFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    vscode.window.showWarningMessage('Snapgent: Skill file not found');
    pushSidebarState();
    return;
  }
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}

async function manageSkills() {
  const workspacePath = getPrimaryWorkspacePath();
  if (!workspacePath) {
    vscode.window.showWarningMessage('Snapgent: Open a workspace folder to manage skills');
    return;
  }

  const skills = listWorkspaceSkills();
  const items = skills.map((s) => ({
    label: `$(book) ${s.name}`,
    description: `.snapgent/skills/${s.name}/SKILL.md`,
    skillFile: s.file,
  }));

  items.push({
    label: '$(add) Create new skill',
    description: 'Create .snapgent/skills/<name>/SKILL.md',
    createNew: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a skill to open or create a new one',
  });
  if (!picked) {
    return;
  }

  if (picked.createNew) {
    await createNewSkill();
    return;
  }

  await openSkillFile(picked.skillFile);
}

async function configureBridgePort() {
  const currentPort = String(getBridgePort());
  const input = await vscode.window.showInputBox({
    prompt: 'SnapgentV3 Bridge WebSocket port',
    value: currentPort,
    validateInput: (val) => {
      const num = Number(val.trim());
      return Number.isInteger(num) && num > 0 && num <= 65535 ? null : 'Enter a valid port (1-65535)';
    },
  });
  if (!input) {
    return;
  }
  const newPort = Number(input.trim());
  await vscode.workspace.getConfiguration('snapgent').update('bridgePort', newPort, vscode.ConfigurationTarget.Global);
  addLog('info', `Bridge port updated to ${newPort}`);
}

async function refreshBridge() {
  await runWithProgress('Refreshing bridge', async () => {
    if (!sendBridgeMessage({ type: 'list_tools', id: `vscode-${Date.now()}` })) {
      connectBridge();
    } else {
      addLog('info', 'Requested tool list refresh');
    }
    await new Promise((r) => setTimeout(r, 400));
  });
}

async function restartMcpServers() {
  await runWithProgress('Restarting MCP servers', async () => {
    if (!sendBridgeMessage({ type: 'restart_mcp', id: `vscode-${Date.now()}` })) {
      addLog('warn', 'Restart skipped: bridge offline');
      vscode.window.showWarningMessage('Snapgent: Bridge is offline');
      return;
    }
    addLog('info', 'Sent restart_mcp command');
    vscode.window.showInformationMessage('Snapgent: Requested MCP server restart');
    await new Promise((r) => setTimeout(r, 600));
  });
}

async function openBridgeMenu() {
  const items = [
    {
      label: '$(sync) Sync active workspace',
      description: getPrimaryWorkspacePath() || 'No workspace open',
      action: () => syncActiveWorkspace(false),
    },
    {
      label: '$(refresh) Refresh bridge status',
      description: bridgeState.connected ? 'Connected' : 'Reconnect',
      action: () => refreshBridge(),
    },
    {
      label: '$(debug-restart) Restart MCP servers',
      description: 'Send restart_mcp to bridge',
      action: () => restartMcpServers(),
    },
    {
      label: '$(book) Manage workspace skills',
      description: '.snapgent/skills/*/SKILL.md',
      action: () => manageSkills(),
    },
    {
      label: '$(clippy) Send selection to Snapgent',
      description: 'Copy code with path and line range',
      action: () => sendSelectionToSnapgent(),
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: bridgeState.connected
      ? `SnapgentV3 Bridge (${bridgeState.toolCount} tools)`
      : 'SnapgentV3 Bridge (Offline)',
  });
  if (picked && picked.action) {
    await picked.action();
  }
}

class SnapgentSidebarProvider {
  constructor() {
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || !msg.type) {
        return;
      }
      switch (msg.type) {
        case 'ready':
          pushSidebarState();
          break;
        case 'syncWorkspace':
          syncActiveWorkspace(false);
          break;
        case 'refreshBridge':
          await refreshBridge();
          break;
        case 'restartMcp':
          await restartMcpServers();
          break;
        case 'manageSkills':
          await manageSkills();
          break;
        case 'createSkill':
          await createNewSkill();
          break;
        case 'openSkill':
          await openSkillFile(msg.file);
          break;
        case 'sendSelection':
          await sendSelectionToSnapgent();
          break;
        case 'changePort':
          await configureBridgePort();
          break;
        case 'copyWorkspace': {
          const ws = getPrimaryWorkspacePath();
          if (ws) {
            await vscode.env.clipboard.writeText(ws);
            addLog('info', 'Copied workspace path');
          }
          break;
        }
        case 'copyTool': {
          if (msg.name) {
            const snippet = JSON.stringify({ command: msg.name, params: {} });
            await vscode.env.clipboard.writeText(snippet);
            addLog('info', `Copied command template: ${msg.name}`);
            vscode.window.showInformationMessage(`Snapgent: Copied template for ${msg.name}`);
          }
          break;
        }
        case 'copyLogs': {
          const text = bridgeState.logs.map((l) => `[${l.time}] [${l.level}] ${l.message}`).join('\n');
          await vscode.env.clipboard.writeText(text || 'No logs');
          vscode.window.showInformationMessage('Snapgent: Copied activity log');
          break;
        }
        case 'clearLogs':
          bridgeState.logs = [];
          pushSidebarState();
          break;
        default:
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this._view = null;
    });

    pushSidebarState();
  }

  postState(state) {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({ type: 'state', payload: state });
  }

  _getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --card: color-mix(in srgb, var(--vscode-foreground, #e4e4e7) 3%, transparent);
      --card-hover: color-mix(in srgb, var(--vscode-foreground, #e4e4e7) 6%, transparent);
      --hairline: color-mix(in srgb, var(--vscode-foreground, #e4e4e7) 9%, transparent);
      --text-primary: var(--vscode-foreground, #e4e4e7);
      --text-secondary: color-mix(in srgb, var(--vscode-foreground, #e4e4e7) 72%, transparent);
      --text-muted: var(--vscode-descriptionForeground, #a1a1aa);
      --accent: var(--vscode-focusBorder, #60a5fa);
      --ok: color-mix(in srgb, var(--vscode-testing-iconPassed, #4ade80) 78%, var(--text-primary));
      --warn: color-mix(in srgb, var(--vscode-editorWarning-foreground, #eab308) 80%, var(--text-primary));
      --err: color-mix(in srgb, var(--vscode-editorError-foreground, #f87171) 80%, var(--text-primary));
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.45;
      color: var(--text-primary);
      background: transparent;
    }

    .stack { display: flex; flex-direction: column; gap: 16px; }

    .panel {
      background: var(--card);
      border: 1px solid var(--hairline);
      border-radius: 12px;
      padding: 12px;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .section-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-label svg {
      width: 16px;
      height: 16px;
      stroke-width: 1.5;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 8px;
      border: 1px solid var(--hairline);
      background: var(--card);
      font-size: 11px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: var(--text-primary);
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--err);
      transition: background-color 160ms var(--ease);
    }
    .dot.online { background: var(--ok); }
    .dot.busy { background: var(--warn); }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }

    .metric {
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--hairline);
      background: transparent;
      text-align: left;
      font-family: inherit;
      color: inherit;
    }

    .metric.clickable {
      cursor: pointer;
      transition: background-color 140ms var(--ease);
    }
    .metric.clickable:hover { background: var(--card-hover); }

    .metric-label { font-size: 11px; color: var(--text-muted); }
    .metric-val {
      margin-top: 2px;
      font-size: 14px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--text-primary);
    }

    .progress-wrap {
      margin-top: 12px;
      height: 4px;
      border-radius: 2px;
      background: var(--hairline);
      overflow: hidden;
      opacity: 0;
      transition: opacity 160ms var(--ease);
    }
    .progress-wrap.active { opacity: 1; }

    .progress-fill {
      height: 100%;
      width: 36%;
      border-radius: 2px;
      background: var(--accent);
      animation: track-sweep 1.2s var(--ease) infinite;
    }

    @keyframes track-sweep {
      0% { transform: translateX(-110%); }
      100% { transform: translateX(360%); }
    }

    .tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
      padding: 4px;
      border-radius: 10px;
      border: 1px solid var(--hairline);
      background: var(--card);
    }

    .tab-btn {
      border: none;
      border-radius: 8px;
      padding: 6px 6px;
      font-size: 11px;
      font-weight: 500;
      font-family: inherit;
      color: var(--text-secondary);
      background: transparent;
      cursor: pointer;
      transition: background-color 140ms var(--ease), color 140ms var(--ease);
    }
    .tab-btn:hover { color: var(--text-primary); }
    .tab-btn.active {
      background: var(--card-hover);
      color: var(--text-primary);
      box-shadow: inset 0 0 0 1px var(--hairline);
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 11px;
      font-weight: 500;
      font-family: inherit;
      color: var(--text-primary);
      background: var(--card);
      cursor: pointer;
      transition: background-color 140ms var(--ease), transform 100ms var(--ease);
    }
    .action-btn:hover { background: var(--card-hover); }
    .action-btn:active { transform: scale(0.98); }
    .action-btn.primary {
      background: var(--vscode-button-background, var(--text-primary));
      color: var(--vscode-button-foreground, #111113);
      border-color: transparent;
    }
    .action-btn.primary:hover { opacity: 0.92; }
    .action-btn.wide { grid-column: span 2; }

    .action-btn svg {
      width: 14px;
      height: 14px;
      stroke-width: 1.5;
      flex-shrink: 0;
    }

    .path-box {
      margin-top: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--text-secondary);
      word-break: break-all;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid var(--hairline);
    }

    .list-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 32px;
      padding: 4px;
      border-bottom: 1px solid var(--hairline);
      font-size: 11px;
    }
    .list-row:last-child { border-bottom: none; }

    .skill-row {
      width: 100%;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 11px;
      text-align: left;
      cursor: pointer;
      border-radius: 6px;
      padding: 6px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background-color 140ms var(--ease);
    }
    .skill-row:hover { background: var(--card-hover); }

    .tool-row {
      width: 100%;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      background: transparent;
      color: var(--text-primary);
      text-align: left;
      padding: 8px;
      cursor: pointer;
      font-family: inherit;
      transition: background-color 140ms var(--ease);
    }
    .tool-row:hover { background: var(--card-hover); }
    .tool-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      font-weight: 500;
      color: var(--text-primary);
    }
    .tool-desc {
      margin-top: 2px;
      font-size: 11px;
      color: var(--text-muted);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .search-input {
      width: 100%;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid var(--hairline);
      background: transparent;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 11px;
      margin-bottom: 8px;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent); }

    .mono-num {
      font-family: var(--vscode-editor-font-family, monospace);
      font-variant-numeric: tabular-nums;
      color: var(--text-muted);
    }

    .chip-btn {
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 3px 8px;
      font-size: 11px;
      font-family: inherit;
      color: var(--text-muted);
      background: transparent;
      cursor: pointer;
      transition: color 140ms var(--ease), background-color 140ms var(--ease);
    }
    .chip-btn:hover { color: var(--text-primary); }
    .chip-btn.active {
      color: var(--text-primary);
      background: var(--card-hover);
    }

    .scroll-list {
      max-height: 280px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .log-item {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 4px 6px;
      border-radius: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--text-secondary);
    }
    .log-item.warn { color: var(--warn); }
    .log-item.error { color: var(--err); }
    .log-time { color: var(--text-muted); flex-shrink: 0; }
    .run-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 28px;
      padding: 4px;
      border-bottom: 1px solid var(--hairline);
      font-size: 11px;
    }
    .run-row:last-child { border-bottom: none; }
    .run-left {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .run-name {
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .muted { font-size: 11px; color: var(--text-muted); }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="stack">
    <div class="panel">
      <div class="row">
        <div class="section-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 12h4l2-5 4 10 2-5h4"/></svg>
          <span>Bridge status</span>
        </div>
        <div class="status-pill">
          <span class="dot" id="statusDot"></span>
          <span id="statusText">Offline</span>
        </div>
      </div>

      <div class="metrics">
        <button class="metric clickable" id="btnPort" title="Change bridge port">
          <div class="metric-label">Port</div>
          <div class="metric-val" id="portVal">17613</div>
        </button>
        <div class="metric">
          <div class="metric-label">Tools</div>
          <div class="metric-val" id="toolVal">0</div>
        </div>
      </div>

      <div class="progress-wrap" id="progressWrap">
        <div class="progress-fill"></div>
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab-btn active" id="tabOverview" role="tab">Overview</button>
      <button class="tab-btn" id="tabTools" role="tab">Tools</button>
      <button class="tab-btn" id="tabLogs" role="tab">Logs</button>
    </div>

    <div id="viewOverview" class="stack">
      <div class="actions">
        <button class="action-btn primary" id="btnSync">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          <span>Sync workspace</span>
        </button>
        <button class="action-btn" id="btnRefresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          <span>Refresh bridge</span>
        </button>
        <button class="action-btn" id="btnRestart">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>
          <span>Restart mcp</span>
        </button>
        <button class="action-btn" id="btnSelection">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>Send selection</span>
        </button>
      </div>

      <div class="panel">
        <div class="row" style="margin-bottom:8px">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            <span>Live web activity</span>
          </div>
          <span class="mono-num" id="activeCount">Idle</span>
        </div>
        <div id="activityFeed" class="muted">Waiting for web commands</div>
      </div>

      <div class="panel">
        <div class="row">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>
            <span>Active workspace</span>
          </div>
          <button class="chip-btn" id="btnCopyWs">Copy</button>
        </div>
        <div class="path-box" id="workspacePath">No workspace open</div>
      </div>

      <div class="panel">
        <div class="row" style="margin-bottom:8px">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
            <span>Workspace skills</span>
          </div>
          <button class="chip-btn" id="btnNewSkill">New</button>
        </div>
        <div id="skillList" class="muted">No skills in .snapgent/skills</div>
      </div>

      <div class="panel">
        <div class="section-label" style="margin-bottom:8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="20" height="6" rx="2"/><rect x="2" y="15" width="20" height="6" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/></svg>
          <span>Mcp servers</span>
        </div>
        <div id="serverList" class="muted">No servers reported</div>
      </div>
    </div>

    <div id="viewTools" class="panel hidden">
      <input type="text" class="search-input" id="toolSearch" placeholder="Filter tools" />
      <div id="toolList" class="scroll-list">
        <div class="muted">No tools reported</div>
      </div>
    </div>

    <div id="viewLogs" class="panel hidden">
      <div class="row" style="margin-bottom:8px">
        <div style="display:inline-flex;gap:4px">
          <button class="chip-btn active" id="filterAll">All</button>
          <button class="chip-btn" id="filterIssues">Issues</button>
        </div>
        <div style="display:inline-flex;gap:4px">
          <button class="chip-btn" id="btnCopyLogs">Copy</button>
          <button class="chip-btn" id="btnClear">Clear</button>
        </div>
      </div>
      <div id="logList" class="scroll-list">
        <div class="muted">No events recorded</div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let latestState = { logs: [], tools: [], skills: [] };
    let logFilter = 'all';
    let toolQuery = '';

    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const portVal = document.getElementById('portVal');
    const toolVal = document.getElementById('toolVal');
    const progressWrap = document.getElementById('progressWrap');
    const workspacePath = document.getElementById('workspacePath');
    const skillList = document.getElementById('skillList');
    const activeCount = document.getElementById('activeCount');
    const activityFeed = document.getElementById('activityFeed');
    const serverList = document.getElementById('serverList');
    const toolList = document.getElementById('toolList');
    const toolSearch = document.getElementById('toolSearch');
    const logList = document.getElementById('logList');

    const views = {
      overview: document.getElementById('viewOverview'),
      tools: document.getElementById('viewTools'),
      logs: document.getElementById('viewLogs'),
    };
    const tabs = {
      overview: document.getElementById('tabOverview'),
      tools: document.getElementById('tabTools'),
      logs: document.getElementById('tabLogs'),
    };
    const filterAll = document.getElementById('filterAll');
    const filterIssues = document.getElementById('filterIssues');

    function setTab(name) {
      Object.keys(views).forEach((key) => {
        const active = key === name;
        views[key].classList.toggle('hidden', !active);
        tabs[key].classList.toggle('active', active);
      });
    }

    function setFilter(mode) {
      logFilter = mode;
      filterAll.classList.toggle('active', mode === 'all');
      filterIssues.classList.toggle('active', mode === 'issues');
      renderLogs(latestState.logs || []);
    }

    tabs.overview.addEventListener('click', () => setTab('overview'));
    tabs.tools.addEventListener('click', () => setTab('tools'));
    tabs.logs.addEventListener('click', () => setTab('logs'));
    filterAll.addEventListener('click', () => setFilter('all'));
    filterIssues.addEventListener('click', () => setFilter('issues'));

    toolSearch.addEventListener('input', (e) => {
      toolQuery = String(e.target.value || '').trim().toLowerCase();
      renderTools(latestState.tools || []);
    });

    document.getElementById('btnPort').addEventListener('click', () => vscode.postMessage({ type: 'changePort' }));
    document.getElementById('btnSync').addEventListener('click', () => vscode.postMessage({ type: 'syncWorkspace' }));
    document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshBridge' }));
    document.getElementById('btnRestart').addEventListener('click', () => vscode.postMessage({ type: 'restartMcp' }));
    document.getElementById('btnSelection').addEventListener('click', () => vscode.postMessage({ type: 'sendSelection' }));
    document.getElementById('btnCopyWs').addEventListener('click', () => vscode.postMessage({ type: 'copyWorkspace' }));
    document.getElementById('btnNewSkill').addEventListener('click', () => vscode.postMessage({ type: 'createSkill' }));
    document.getElementById('btnCopyLogs').addEventListener('click', () => vscode.postMessage({ type: 'copyLogs' }));
    document.getElementById('btnClear').addEventListener('click', () => vscode.postMessage({ type: 'clearLogs' }));

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderTools(tools) {
      const filtered = toolQuery
        ? tools.filter((t) => t.name.toLowerCase().includes(toolQuery) || t.description.toLowerCase().includes(toolQuery))
        : tools;

      if (!filtered || filtered.length === 0) {
        toolList.innerHTML = '<div class="muted">No matching tools</div>';
        return;
      }

      toolList.innerHTML = filtered.map((t) => {
        const desc = t.description ? '<div class="tool-desc">' + escapeHtml(t.description) + '</div>' : '';
        return '<button class="tool-row" data-tool="' + escapeHtml(t.name) + '"><div class="tool-name">' + escapeHtml(t.name) + '</div>' + desc + '</button>';
      }).join('');

      toolList.querySelectorAll('.tool-row').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'copyTool', name: btn.getAttribute('data-tool') });
        });
      });
    }

    function renderSkills(skills) {
      if (!Array.isArray(skills) || skills.length === 0) {
        skillList.className = 'muted';
        skillList.textContent = 'No skills in .snapgent/skills';
        return;
      }
      skillList.className = '';
      skillList.innerHTML = skills.map((s) => {
        return '<button class="skill-row" data-file="' + escapeHtml(s.file) + '"><span>' + escapeHtml(s.name) + '</span><span class="mono-num">Open</span></button>';
      }).join('');

      skillList.querySelectorAll('.skill-row').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'openSkill', file: btn.getAttribute('data-file') });
        });
      });
    }

    function renderLogs(logs) {
      const filtered = logFilter === 'issues'
        ? logs.filter((entry) => entry.level === 'warn' || entry.level === 'error')
        : logs;

      if (!filtered || filtered.length === 0) {
        logList.innerHTML = '<div class="muted">No matching events</div>';
        return;
      }

      logList.innerHTML = filtered.map((entry) => {
        const cls = entry.level === 'error' ? 'error' : (entry.level === 'warn' ? 'warn' : '');
        return '<div class="log-item ' + cls + '"><span class="log-time">' + escapeHtml(entry.time) + '</span><span>' + escapeHtml(entry.message) + '</span></div>';
      }).join('');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'state') return;
      const s = msg.payload;
      latestState = s;

      const activeTasks = Array.isArray(s.activeTasks) ? s.activeTasks : [];
      const recentRuns = Array.isArray(s.recentRuns) ? s.recentRuns : [];
      const isBusy = Boolean(s.busy || s.connecting || activeTasks.length > 0);
      progressWrap.classList.toggle('active', isBusy);

      statusDot.className = 'dot' + (isBusy ? ' busy' : (s.connected ? ' online' : ''));
      if (activeTasks.length > 0) {
        statusText.textContent = activeTasks[0].tool;
      } else if (s.busy || s.connecting) {
        statusText.textContent = s.busyText || 'Connecting';
      } else if (s.connected) {
        statusText.textContent = s.bridgeVersion ? 'v' + s.bridgeVersion : 'Connected';
      } else {
        statusText.textContent = 'Offline';
      }

      activeCount.textContent = activeTasks.length > 0 ? (activeTasks.length + ' running') : 'Idle';
      const feedRows = [];
      activeTasks.forEach((t) => {
        feedRows.push('<div class="run-row"><span class="run-left"><span class="dot busy"></span><span class="run-name">' + escapeHtml(t.tool) + '</span></span><span class="mono-num">running</span></div>');
      });
      recentRuns.slice(0, 6).forEach((r) => {
        const dotCls = r.ok ? 'online' : '';
        feedRows.push('<div class="run-row"><span class="run-left"><span class="dot ' + dotCls + '"></span><span class="run-name">' + escapeHtml(r.tool) + '</span></span><span class="mono-num">' + escapeHtml(r.durationMs + 'ms') + '</span></div>');
      });
      if (feedRows.length > 0) {
        activityFeed.className = '';
        activityFeed.innerHTML = feedRows.join('');
      } else {
        activityFeed.className = 'muted';
        activityFeed.textContent = 'Waiting for web commands';
      }

      portVal.textContent = String(s.port || 17613);
      toolVal.textContent = String(s.toolCount || 0);
      workspacePath.textContent = s.workspace || 'No workspace open';

      if (Array.isArray(s.servers) && s.servers.length > 0) {
        serverList.className = '';
        serverList.innerHTML = s.servers.map((srv) => {
          const detail = srv.alive ? (srv.tools + ' tools') : 'offline';
          return '<div class="list-row"><span>' + escapeHtml(srv.id) + '</span><span class="mono-num">' + escapeHtml(detail) + '</span></div>';
        }).join('');
      } else {
        serverList.className = 'muted';
        serverList.textContent = 'No servers reported';
      }

      renderSkills(s.skills || []);
      renderTools(s.tools || []);
      renderLogs(s.logs || []);
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function activate(context) {
  isDisposing = false;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'snapgent.openMenu';
  statusBarItem.show();
  updateStatusBar();

  sidebarProvider = new SnapgentSidebarProvider();

  syncActiveWorkspace(true);
  connectBridge();

  context.subscriptions.push(
    statusBarItem,
    vscode.window.registerWebviewViewProvider('snapgent.sidebarView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('snapgent.openMenu', openBridgeMenu),
    vscode.commands.registerCommand('snapgent.sendSelection', sendSelectionToSnapgent),
    vscode.commands.registerCommand('snapgent.manageSkills', manageSkills),
    vscode.commands.registerCommand('snapgent.syncWorkspace', () => syncActiveWorkspace(false)),
    vscode.commands.registerCommand('snapgent.restartMcp', restartMcpServers),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        syncActiveWorkspace(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncActiveWorkspace(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('snapgent.bridgePort')) {
        if (socket) {
          socket.close();
        }
        connectBridge();
      }
    })
  );
}

function deactivate() {
  isDisposing = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      // Ignore
    }
    socket = null;
  }
}

module.exports = {
  activate,
  deactivate,
};
