const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const STATE_DIR = path.join(os.homedir(), '.snapgent');
const STATE_FILE = path.join(STATE_DIR, 'active-workspace.json');

let statusBarItem = null;
let socket = null;
let reconnectTimer = null;
let isDisposing = false;
let bridgeState = {
  connected: false,
  bridgeVersion: null,
  servers: [],
  toolCount: 0,
};

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

function syncActiveWorkspace(silent = true) {
  const workspacePath = getPrimaryWorkspacePath();
  if (!workspacePath) {
    if (!silent) {
      vscode.window.showWarningMessage('Snapgent: No open workspace folder to sync.');
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
    if (!silent) {
      vscode.window.showInformationMessage(`Snapgent: Synced workspace (${path.basename(workspacePath)})`);
    }
    return true;
  } catch (error) {
    if (!silent) {
      vscode.window.showErrorMessage(`Snapgent: Failed to sync workspace: ${error.message}`);
    }
    return false;
  }
}

function getBridgePort() {
  const config = vscode.workspace.getConfiguration('snapgent');
  const port = Number(config.get('bridgePort', 17613));
  return Number.isFinite(port) && port > 0 ? port : 17613;
}

function updateStatusBar() {
  if (!statusBarItem) {
    return;
  }
  if (!bridgeState.connected) {
    statusBarItem.text = '$(plug) Snapgent: Offline';
    statusBarItem.tooltip = `SnapgentV3 Bridge offline (port ${getBridgePort()}). Click to open menu.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  const ver = bridgeState.bridgeVersion ? `v${bridgeState.bridgeVersion}` : 'Connected';
  statusBarItem.text = `$(radio-tower) Snapgent: ${ver} (${bridgeState.toolCount} tools)`;
  const serverSummary = bridgeState.servers.length
    ? bridgeState.servers.map((s) => `${s.id}: ${s.alive ? `${s.tools} tools` : 'offline'}`).join('\n')
    : 'No MCP servers reported';
  statusBarItem.tooltip = `SnapgentV3 Bridge (${ver})\n${serverSummary}\nClick to open menu.`;
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
    updateStatusBar();
    return;
  }
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
    return;
  }

  const url = `ws://127.0.0.1:${getBridgePort()}`;
  try {
    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener('open', () => {
      bridgeState.connected = true;
      updateStatusBar();
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data || '{}'));
        if (data.type === 'connected' || data.type === 'tools' || data.type === 'mcp_status') {
          bridgeState.connected = true;
          if (data.bridge_version) {
            bridgeState.bridgeVersion = data.bridge_version;
          }
          if (Array.isArray(data.servers)) {
            bridgeState.servers = data.servers;
          }
          if (Array.isArray(data.tools)) {
            bridgeState.toolCount = data.tools.length;
          }
          updateStatusBar();
        }
      } catch {
        // Ignore malformed frames
      }
    });

    ws.addEventListener('close', () => {
      if (socket === ws) {
        socket = null;
      }
      bridgeState.connected = false;
      updateStatusBar();
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      bridgeState.connected = false;
      updateStatusBar();
    });
  } catch {
    bridgeState.connected = false;
    updateStatusBar();
    scheduleReconnect();
  }
}

async function sendSelectionToSnapgent() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Snapgent: No active editor.');
    return;
  }
  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (!selectedText.trim()) {
    vscode.window.showWarningMessage('Snapgent: Select some code first.');
    return;
  }

  const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  const lang = editor.document.languageId || '';
  const formatted = `File: \`${relPath}\` (L${startLine}-L${endLine})\n\`\`\`${lang}\n${selectedText}\n\`\`\``;

  await vscode.env.clipboard.writeText(formatted);
  vscode.window.showInformationMessage(`Snapgent: Copied ${relPath} (L${startLine}-L${endLine}) to clipboard.`);
}

async function manageSkills() {
  const workspacePath = getPrimaryWorkspacePath();
  if (!workspacePath) {
    vscode.window.showWarningMessage('Snapgent: Open a workspace folder to manage skills.');
    return;
  }

  const skillsRoot = path.join(workspacePath, '.snapgent', 'skills');
  const items = [];

  if (fs.existsSync(skillsRoot)) {
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        items.push({
          label: `$(book) ${entry.name}`,
          description: '.snapgent/skills/' + entry.name + '/SKILL.md',
          skillFile,
        });
      }
    }
  }

  items.push({
    label: '$(add) Create New Skill...',
    description: 'Create a new .snapgent/skills/<name>/SKILL.md template',
    createNew: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a Snapgent skill to open or create a new one',
  });
  if (!picked) {
    return;
  }

  if (picked.createNew) {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter skill folder name (e.g. code-review)',
      validateInput: (val) => (/^[a-z0-9-]+$/i.test(val.trim()) ? null : 'Use letters, numbers, and hyphens only'),
    });
    if (!name) {
      return;
    }
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
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(picked.skillFile);
  await vscode.window.showTextDocument(doc);
}

async function restartMcpServers() {
  if (!sendBridgeMessage({ type: 'restart_mcp', id: `vscode-${Date.now()}` })) {
    vscode.window.showWarningMessage('Snapgent: Bridge is offline. Start bridge.py / start.bat first.');
    return;
  }
  vscode.window.showInformationMessage('Snapgent: Requested MCP server restart.');
}

async function openBridgeMenu() {
  const items = [
    {
      label: '$(sync) Sync Active Workspace Now',
      description: getPrimaryWorkspacePath() || 'No workspace open',
      action: () => syncActiveWorkspace(false),
    },
    {
      label: '$(refresh) Refresh Bridge Status',
      description: bridgeState.connected ? 'Connected' : 'Reconnect to bridge',
      action: () => {
        if (!sendBridgeMessage({ type: 'list_tools', id: `vscode-${Date.now()}` })) {
          connectBridge();
        }
      },
    },
    {
      label: '$(debug-restart) Restart MCP Servers',
      description: 'Send restart_mcp to bridge.py',
      action: () => restartMcpServers(),
    },
    {
      label: '$(book) Manage Workspace Skills',
      description: '.snapgent/skills/*/SKILL.md',
      action: () => manageSkills(),
    },
    {
      label: '$(clippy) Send Selection to Snapgent',
      description: 'Copy selected code with file path and line range',
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

function activate(context) {
  isDisposing = false;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'snapgent.openMenu';
  statusBarItem.show();
  updateStatusBar();

  syncActiveWorkspace(true);
  connectBridge();

  context.subscriptions.push(
    statusBarItem,
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
