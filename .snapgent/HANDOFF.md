# SnapgentV3 - Project Handoff & Planning (`.snapgent/HANDOFF.md`)

## 1. Current Status
- **Active Feature:** Multi-Tab Subagent Orchestration (`spawn_subagent` & `spawn_subagents`)
- **Syntax & Integrity:** All modified extension files (`snapgent-extension/background.js`, `snapgent-extension/core/config.js`, `snapgent-extension/core/main.js`, `snapgent-extension/test-background.js`) pass `node --check`, and `node snapgent-extension/test-background.js` passes all 19 assertions.
- **Documentation:** Updated in `README.md`, `snapgent-extension/README.md`, `CHANGELOG.md`, and this handoff document.

## 2. Implemented Capabilities
1. **12-Provider Routing & Alias Normalization (`snapgent-extension/background.js`)**
   - Supported canonical providers: `claude`, `chatgpt`, `qwen`, `deepseek`, `gemini`, `grok`, `mistral`, `meta`, `kimi`, `glm`, `arena`, `ptero`.
   - Supported aliases (`SUBAGENT_PROVIDER_ALIASES`): `gpt`, `openai`, `chatgpt-cm`, `anthropic`, `google`, `zai`, `z.ai`, `chatglm`, `qwen-net`, `meta-ai`, `lechat`.
   - Unknown providers return an explicit error listing all supported provider names rather than silently falling back.
2. **Anti-Throttling Hydration, Focus Queue & Stage Diagnostics (`snapgent-extension/background.js`, `snapgent-extension/core/main.js`)**
   - Child tabs open active so Chromium/Edge hydrates heavy SPA frameworks without background throttling, serialized via `enqueueSubagentFocus` (`subagentFocusChain` / `subagentFocusPending`) to prevent focus races and restore focus to `parentTabId` once pending focus work drains.
   - Split focus-release strategy: `core/main.js` emits `zs-subagent-submitted` right after `submitAndGetBase`. General providers release focus on `zs-subagent-submitted` (with a 35s safety guard), while `chatgpt`, `gemini`, `qwen`, and `deepseek` use `holdUntilDone` to keep focus until `zs-subagent-done` (or session settlement/tab close) so background throttling does not stall streaming/DOM updates.
   - Filtered Gemini UI follow-up/suggestion chips (`UI_NOISE` selector list in `textWithout()`) in `snapgent-extension/providers/gemini.js` so chip text is not appended to scraped responses.
   - Tracks session lifecycle stages (`creating_tab`, `loading_tab`, `handshaking_content_script`, `running_task`) and cleans up child tabs, timers, and focus guards via `settleSubagent` and `chrome.tabs.onRemoved`.
3. **Single-Turn Immediate Bootstrap & Parallel Batch Runner (`snapgent-extension/core/main.js`)**
   - Combines system prompt and delegated task in one initial turn to halve startup latency, and supports `spawn_subagents` (`spawnSubagentBatch` via `Promise.all` up to `MAX_PARALLEL_SUBAGENTS = 6`).
4. **Agent Prompt Exposure (`snapgent-extension/core/config.js`)**
   - `toolsReminder` advertises both `spawn_subagent(task, provider?, auto_close?)` and `spawn_subagents(tasks, provider?, auto_close?)` along with all 12 supported AI providers.
5. **Unit Test Suite (`snapgent-extension/test-background.js`)**
   - Covers connection/send retry safety, `ping` routing, all 12 canonical providers, alias normalization, unknown-provider errors, blank-task rejection, the 6-tab batch limit, and `settleSubagent` session/tab cleanup.

## 3. Roadmap & Next Tasks
- [x] **Parallel Subagent Execution (`spawn_subagents`)**
  - Added batch virtual command `spawn_subagents` in `core/main.js` and `spawnSubagentBatch` in `background.js` executing subtasks concurrently via `Promise.all` (capped at 6 parallel tabs).
  - Added serialized `enqueueSubagentFocus` in `background.js` so multiple child tabs hydrate sequentially without focus race conditions before restoring focus to `parentTabId`.
- [x] **Unit & Integration Tests (`snapgent-extension/test-background.js`)**
  - Added Node tests covering `SUBAGENT_PROVIDER_URLS`, `SUBAGENT_PROVIDER_ALIASES`, unknown-provider error responses, batch limits, and `settleSubagent` session/tab cleanup.
- [x] **Live Multi-Provider Smoke Verification**
  - Verified `chatgpt` live via `spawn_subagent` with `auto_close: true` (`SUBAGENT_OK`, resolving the previous 240s `running_task` timeout).
  - Verified parallel `spawn_subagents` (`gemini` + `chatgpt`) with `auto_close: true` hands-free without manual tab switching (`GEMINI_OK` + `CHATGPT_OK`).
  - Verified parallel `spawn_subagents` (`qwen` + `deepseek` + `chatgpt`) with `auto_close: true` hands-free after adding `qwen` and `deepseek` to `holdUntilDone` (`QWEN_OK`, `DEEPSEEK_OK`, `CHATGPT_OK`).
  - Note: `claude` skipped for now due to organization account block; Gemini `UI_NOISE` filter added in `providers/gemini.js` (syntax checked, ready for live re-verify after reload).
- [ ] **Standalone App Sync (`snapgent-app/extension`)**
  - Port Multi-Tab Subagent changes into `snapgent-app/extension` when preparing the next desktop build.
- [ ] **VS Code / Antigravity IDE Extension (`.vsix`)**
  - Build a unified VS Code / Antigravity companion extension (single `.vsix` codebase) to integrate SnapgentV3 directly inside the IDE.
  - **Core & Bridge Integration:** Accurate native workspace detection (`workspaceFolders`, active editor/cursor), status bar indicator for bridge connection (`port 17613`) with one-click start/restart, and auto-switch active window tracking across multiple IDE windows.
  - **Editor & Context Tools:** Right-click/shortcut *"Send to Snapgent"* (selected code + file path + line range), native `get_diagnostics` (Problems panel errors/warnings), and live native diff preview with one-click Accept/Revert for AI edits.
  - **Sidebar Monitor & Skills:** Real-time MCP command activity log, active subagent monitor (`gemini`, `chatgpt`, `qwen`, `deepseek`) with Emergency Stop, and a visual `.snapgent/skills/` toggle/manager.
  - **Terminal Execution:** Visible Integrated Terminal execution for `run_command` so output is live and interruptible (`Ctrl+C`).
