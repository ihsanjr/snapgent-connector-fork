# SnapgentV3 Companion (VS Code & Antigravity IDE)

Lightweight, zero-dependency companion extension for **SnapgentV3** in VS Code and Antigravity IDE.

## MVP v0.1 Features
1. **Bridge Status Bar (`ws://127.0.0.1:17613`)**: Shows live connection status, bridge version, and active MCP tool count. Click to open the quick menu (Refresh Status, Restart MCP Servers, Sync Workspace, Manage Skills).
2. **Active Workspace Sync**: Automatically writes the focused workspace path to `~/.snapgent/active-workspace.json` so `antigravity_mcp.py` and `vscode_mcp.py` always target the exact active window.
3. **Send Selection to Snapgent**: Right-click any selected code in the editor to copy it with its relative file path and line range in a clean Markdown block.
4. **Quick Skills Manager**: Run `Snapgent: Manage Skills` from the Command Palette to open or create `.snapgent/skills/<name>/SKILL.md` files.

## Testing Locally
1. Open the `snapgent-vscode` folder in VS Code or Antigravity IDE.
2. Press `F5` to launch an Extension Development Host window.
3. Make sure `bridge.py` (`start.bat`) is running to see the Status Bar connect automatically.

## Packaging to `.vsix`
```bash
cd snapgent-vscode
npx @vscode/vsce package
```
Install the generated `.vsix` via **Extensions â†’ `...` â†’ Install from VSIX...**.
