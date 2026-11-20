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
2. **Anti-Throttling Hydration, Focus Queue & Stage Diagnostics (`snapgent-extension/background.js`)**
   - Child tabs open active briefly so Chromium/Edge hydrates heavy SPA frameworks immediately without background throttling, serialized via `enqueueSubagentFocus` (`subagentFocusChain` / `subagentFocusPending`) to prevent focus races and restore focus to `parentTabId` once pending focus work drains.
   - Tracks session lifecycle stages (`creating_tab`, `loading_tab`, `handshaking_content_script`, `running_task`) and cleans up child tabs and timers via `settleSubagent` and `chrome.tabs.onRemoved`.
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
- [ ] **Live Multi-Provider Smoke Verification**
  - Reload unpacked `snapgent-extension` in Chrome/Edge and run live `spawn_subagent` / `spawn_subagents` checks across `claude`, `chatgpt`, `qwen`, and `deepseek`.
- [ ] **Standalone App Sync (`snapgent-app/extension`)**
  - Port Multi-Tab Subagent changes into `snapgent-app/extension` when preparing the next desktop build.
