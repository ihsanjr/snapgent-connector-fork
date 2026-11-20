# SnapgentV3 Companion (VS Code & Antigravity IDE)

Lightweight, zero-dependency companion extension for **SnapgentV3** in VS Code and Antigravity IDE.

## Features (v0.2.0)
1. **Interactive Sidebar Webview (`SnapgentV3` Activity Bar)**:
   - **Bridge Status & Port Control**: Real-time WebSocket status (`ws://127.0.0.1:17613`), animated progress bar, tool count, and clickable port setting.
   - **Live Web Activity**: Realtime feed of MCP commands executed from the web (`tool_progress` broadcast from `bridge.py`), showing running tools, completion status, and duration (`ms`).
   - **Quick Actions & Workspace Skills**: One-click Sync Workspace, Refresh Bridge, Restart MCP, Send Selection, copy workspace path, and open/create `.snapgent/skills/*/SKILL.md`.
   - **Tools Explorer (`Tools` tab)**: Searchable list of available MCP tools; click any tool to copy its JSON command template.
   - **Activity Log (`Logs` tab)**: Live event stream with `All` / `Issues` filter, Copy, and Clear.
2. **Bridge Status Bar**: Displays live connection status, currently running web tool, bridge version, and active MCP tool count. Click to open the quick menu.
3. **Active Workspace Sync**: Automatically writes the focused workspace path to `~/.snapgent/active-workspace.json` so `antigravity_mcp.py` and `vscode_mcp.py` always target the exact active window.
4. **Send Selection to Snapgent**: Right-click any selected code in the editor to copy it with its relative file path and line range in a clean Markdown block.
5. **Quick Skills Manager**: Run `Snapgent: Manage Skills` from the Command Palette or use the sidebar to manage `.snapgent/skills/<name>/SKILL.md` files.

## Testing Locally
1. Open the `snapgent-vscode` folder in VS Code or Antigravity IDE.
2. Press `F5` to launch an Extension Development Host window.
3. Make sure `bridge.py` (`start.bat`) is running to see the Status Bar and Sidebar connect automatically.

## Packaging & Installing `.vsix`
```bash
cd snapgent-vscode
npx @vscode/vsce package --allow-missing-repository
```
Install via CLI:
```bash
code --install-extension snapgent-vscode/snapgent-companion-0.2.0.vsix
```
Or install manually via **Extensions -> `...` -> Install from VSIX...**, then run **Developer: Reload Window**.
