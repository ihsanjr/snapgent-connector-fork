# snapgentV3 Free - AI Workspace & Studio Agent (Claude, ChatGPT, Qwen, DeepSeek, Gemini, Grok, Mistral, Meta AI, Kimi, GLM, Arena, Ptero)

Control VS Code, Antigravity IDE, Word, or Roblox Studio with AI, for free. snapgentV3 turns a normal AI chat (Claude, ChatGPT, Qwen, DeepSeek, Google Gemini, Grok, Mistral, Meta AI, Kimi, GLM, Arena, or Ptero) into an agent that inspects, builds, and edits your workspace directly through MCP. No API key, no terminal, no copy-paste required.

It's a Chrome/Edge browser extension plus a small local bridge that connects the chat to Roblox Studio or VS Code through MCP. **DeepSeek is the recommended provider.** ChatGPT, Claude, Gemini, Grok, Kimi, GLM, Qwen, Arena, Meta AI and Ptero also work. Grok requires signing in to xAI. On ChatGPT and Claude, screenshots and image input are disabled in this integration. ChatGPT also summarises its own context in long sessions, so snapgentV3 re-states its operating instructions periodically (shown as a "Reminder" chip) to stop it forgetting it can run commands. Gemini and Kimi can be less stable: Gemini tends to stop using the Roblox tools in long sessions, and Kimi sometimes reaches for its own native tools instead of the Roblox commands. On Arena, keep the mode dropdown on **Direct** (snapgentV3 only supports Direct mode).

VS Code is the default **MCP target**. The bridge can start before VS Code, but open the intended project folder in VS Code before clicking **Start** in the chat bar. You can switch to Roblox Studio in the chat bar when its MCP server is enabled. The AI selector beside it opens the supported chat providers.

## Setup

**Load the extension manually (Edge or Chrome):**
1. Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `snapgent-extension` folder
5. The extension is now active

**Then set up the Bridge:**
1. **Download the Bridge** from the [SnapgentV3 release](https://github.com/herdodp/snapgent-connector/releases/tag/V3)
2. **Run the Bridge** - on Windows, double-click `start.bat`; it configures MCP automatically and can run before VS Code is open. Open the project folder in VS Code before clicking **Start** in the chat bar. Roblox Studio is optional: open a place and enable **Assistant AI** > **...** > **Manage MCP Servers** > **Enable Studio as MCP Server** to use that target too.
4. On macOS, double-click `MacOS_Start.command`; the current macOS launcher does not auto-configure VS Code MCP, so configure it in the local `config.json` if you want to use that target. The first launch may show a Gatekeeper warning (normal for downloaded scripts): click **Done**, then **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**.
5. **Go to https://chat.deepseek.com** (recommended), https://chatgpt.com, https://claude.ai, https://gemini.google.com, https://grok.com, https://www.kimi.ai or https://kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai, https://www.meta.ai, or https://ptero.pro, open a new chat (only works on these exact addresses; sign in to Grok first; on Arena use Direct mode)
6. Click **Start session** in the snapgentV3 panel
7. Type what you want to build

## Architecture (for contributors)

The extension is split between a provider-agnostic core and per-AI-site providers:

```
core/config.js        system prompt, feedback strings, tool categories (global ZS)
core/parser.js        snapgentV3 command parsing - pure string logic   (global ZSParse)
core/main.js          agentic loop, UI, camouflage, session state      (uses ZSProvider)
providers/deepseek.js everything DeepSeek-specific: DOM selectors, generation
                      detection, send mechanics, composer modes…       (global ZSProvider)
providers/gemini.js   same interface for Google Gemini (Angular DOM, Quill
                      composer, code-block masking)                    (global ZSProvider)
providers/claude.js   same interface for Claude (contenteditable composer,
                      message and generation detection)                 (global ZSProvider)
providers/kimi.js     same interface for Kimi / Moonshot AI (Vue DOM, Lexical
                      composer, segment-code masking)                  (global ZSProvider)
providers/glm.js      same interface for GLM / Z.ai (Svelte DOM, code-block
                      wrapper masking)                                 (global ZSProvider)
providers/qwen.js     same interface for Qwen / chat.qwen.ai (Vue DOM, network-tap
                      SSE stream, Monaco disposal guard)               (global ZSProvider)
providers/qwen-net.js MAIN-world fetch tap for Qwen SSE stream        (injected by manifest)
providers/chatgpt.js  same interface for ChatGPT / chatgpt.com (React DOM,
                      ProseMirror composer, CodeMirror reply reading) (global ZSProvider)
providers/chatgpt-cm.js MAIN-world CodeMirror tap: republishes each code block's
                      TRUE document (the rendered DOM truncates long
                      lines)                                          (injected by manifest)
providers/arena.js    same interface for Arena / arena.ai (React DOM, multi-model
                      playground, A/B-comparison auto-commit, Direct-mode gate) (global ZSProvider)
providers/meta.js     same interface for Meta AI / meta.ai (React DOM, textarea
                      composer, JSON-viewer + code-collapse masking)   (global ZSProvider)
providers/ptero.js    same interface for Ptero / ptero.pro (textarea composer,
                      message and generation detection)                 (global ZSProvider)
providers/grok.js     same interface for Grok / grok.com (ProseMirror
                      composer, message and generation detection)        (global ZSProvider)
providers/mistral.js  same interface for Mistral / chat.mistral.ai (Vibe Code;
                      generic selectors, needs live-site testing)        (global ZSProvider)
background.js         WebSocket to the local bridge (provider-agnostic)
```

`core/main.js` never touches the host site's DOM directly - it only calls the
`ZSProvider` interface. To integrate another AI site: write a new
`providers/<site>.js` exporting the same interface, then add its URL pattern to
`manifest.json` (`content_scripts` + `host_permissions`) and to
`PROVIDER_URLS` in `background.js`. No core change required.

## Multi-Tab Subagent Orchestration (`spawn_subagent`)

Any active parent AI session can spawn an isolated subagent in a new browser tab across all **12 supported providers** (`claude`, `chatgpt`, `qwen`, `deepseek`, `gemini`, `grok`, `mistral`, `meta`, `kimi`, `glm`, `arena`, `ptero`) and receive a final summary back in chat:

- **Aliases accepted (`SUBAGENT_PROVIDER_ALIASES`)**: `gpt` / `openai` -> `chatgpt`, `anthropic` -> `claude`, `google` -> `gemini`, `zai` / `z.ai` / `chatglm` -> `glm`, `qwen-net` -> `qwen`, `meta-ai` -> `meta`, `lechat` -> `mistral`.
- **Anti-throttling hydration**: Briefly opens the child tab active so Chromium/Edge hydrates the SPA immediately, then restores focus to the parent tab right after handshake.
- **Single-turn immediate bootstrap**: Sends the system instructions and delegated task in one initial turn to halve startup latency.
- **Planned next**: Parallel batch execution (`spawn_subagents` via `Promise.all` + `focusQueue`) and unit test coverage in `test-background.js`.

## Smoke & Unit Tests (plain Node, no dependencies - run from this directory):

- `node test-parser.js` - the command parser (`core/parser.js`).
- `node test-guard.js` - shared retry, heartbeat, and scroll policy (`core/guard.js`).
- `node test-background.js` - service worker WebSocket, heartbeat, and request policy (`background.js`).
- `node test-chatgpt.js` - ChatGPT reply reading (`providers/chatgpt.js`), driven against a stub DOM (CodeMirror line joining, `data-zs-cm` MAIN-world tap, and subtree exclusion).
- `node test-meta.js` - Meta AI reply reading (`providers/meta.js`) against a stub DOM.

All suites print `PASS`/`FAIL` per case and exit non-zero on failure.
