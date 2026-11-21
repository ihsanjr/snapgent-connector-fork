#!/usr/bin/env python3
"""Local OpenAI-compatible AI Gateway for Snapgent Bridge.

Provides:
- Unified provider registry (Ollama, LM Studio, OpenRouter, OpenAI, custom endpoints)
- Model resolution and automatic fallback chains (API -> API -> browser:<provider>)
- Headless subagent execution with MCP tool-calling loop
- Lightweight stdlib HTTP server exposing /v1/models, /v1/providers, /v1/chat/completions
"""

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
PROVIDER_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
DEFAULT_BROWSER_PROVIDERS = (
    "claude",
    "chatgpt",
    "gemini",
    "deepseek",
    "qwen",
    "grok",
    "mistral",
    "meta",
    "kimi",
    "glm",
    "arena",
    "ptero",
)


def _resolve_env(value: str) -> str:
    """Replace ${ENV_VAR} tokens with environment variable values."""
    if not isinstance(value, str) or "${" not in value:
        return value
    return ENV_PATTERN.sub(lambda m: os.environ.get(m.group(1), ""), value)


def _http_post_json(
    url: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
    timeout: float,
) -> Tuple[int, Dict[str, Any]]:
    """Blocking stdlib HTTP POST returning (status_code, parsed_json)."""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace") if err.fp else ""
        try:
            parsed = json.loads(raw) if raw.strip() else {"error": raw or str(err)}
        except json.JSONDecodeError:
            parsed = {"error": raw or str(err)}
        return err.code, parsed


def _mcp_tools_to_openai(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert MCP tool definitions to OpenAI function-calling tool specs."""
    converted = []
    for tool in tools:
        name = tool.get("name")
        if not isinstance(name, str) or not name:
            continue
        schema = tool.get("inputSchema")
        if not isinstance(schema, dict):
            schema = {"type": "object", "properties": {}}
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": str(tool.get("description") or "")[:1024],
                    "parameters": schema,
                },
            }
        )
    return converted


class AIGateway:
    """Manages OpenAI-compatible AI providers, model routing, and fallback chains."""

    def __init__(
        self,
        config_path: Path,
        logger: Optional[Callable[[str], None]] = None,
        browser_executor: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.config_path = config_path
        self._log = logger or (lambda _msg: None)
        self.browser_executor = browser_executor
        self.providers: Dict[str, Dict[str, Any]] = {}
        self.routing: Dict[str, Any] = {
            "defaultProvider": "",
            "fallbackChain": [],
            "subagentRouting": {},
        }
        self.reload()

    def reload(self) -> None:
        """Load aiProviders and routing sections from config.json."""
        self.providers = {}
        self.routing = {
            "defaultProvider": "",
            "fallbackChain": [],
            "subagentRouting": {},
        }
        if not self.config_path.exists():
            return
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            self._log(f"[gateway] failed to read {self.config_path.name}: {err}")
            return
        if not isinstance(data, dict):
            return

        raw_providers = data.get("aiProviders")
        if isinstance(raw_providers, dict):
            for pid, cfg in raw_providers.items():
                if not isinstance(pid, str) or not PROVIDER_ID_PATTERN.fullmatch(pid):
                    continue
                if not isinstance(cfg, dict):
                    continue
                base_url = str(cfg.get("baseUrl") or "").strip().rstrip("/")
                if not base_url:
                    continue
                models = [str(m) for m in cfg.get("models", []) if isinstance(m, str) and m.strip()]
                default_model = str(cfg.get("defaultModel") or (models[0] if models else "")).strip()
                if default_model and default_model not in models:
                    models.insert(0, default_model)
                self.providers[pid] = {
                    "id": pid,
                    "type": str(cfg.get("type") or "openai").strip().lower(),
                    "baseUrl": base_url,
                    "apiKey": str(cfg.get("apiKey") or ""),
                    "models": models,
                    "defaultModel": default_model,
                    "enabled": bool(cfg.get("enabled", True)),
                    "headers": cfg.get("headers") if isinstance(cfg.get("headers"), dict) else {},
                }

        raw_routing = data.get("routing")
        if isinstance(raw_routing, dict):
            default_provider = str(raw_routing.get("defaultProvider") or "").strip()
            fallback_chain = [
                str(item).strip()
                for item in raw_routing.get("fallbackChain", [])
                if isinstance(item, str) and item.strip()
            ]
            subagent_routing = raw_routing.get("subagentRouting")
            if not isinstance(subagent_routing, dict):
                subagent_routing = {}
            self.routing = {
                "defaultProvider": default_provider,
                "fallbackChain": fallback_chain,
                "subagentRouting": subagent_routing,
            }

    def list_providers(self) -> List[Dict[str, Any]]:
        """Return sanitized provider metadata (never exposing raw API keys)."""
        result = []
        for pid, cfg in self.providers.items():
            resolved_key = _resolve_env(cfg.get("apiKey", ""))
            result.append(
                {
                    "id": pid,
                    "type": cfg["type"],
                    "baseUrl": _resolve_env(cfg["baseUrl"]),
                    "models": list(cfg["models"]),
                    "defaultModel": cfg["defaultModel"],
                    "enabled": cfg["enabled"],
                    "hasApiKey": bool(resolved_key),
                }
            )
        return result

    def list_models(self, browser_providers: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """Return OpenAI-compatible /v1/models entries for API + browser providers."""
        now = int(time.time())
        models: List[Dict[str, Any]] = []
        for pid, cfg in self.providers.items():
            if not cfg.get("enabled"):
                continue
            for model_name in cfg.get("models") or ([cfg["defaultModel"]] if cfg.get("defaultModel") else []):
                models.append(
                    {
                        "id": f"{pid}/{model_name}",
                        "object": "model",
                        "created": now,
                        "owned_by": pid,
                    }
                )
        for bprov in browser_providers or list(DEFAULT_BROWSER_PROVIDERS):
            models.append(
                {
                    "id": f"browser/{bprov}",
                    "object": "model",
                    "created": now,
                    "owned_by": "snapgent-browser",
                }
            )
        return models

    def is_api_provider(self, provider: Optional[str]) -> bool:
        if not isinstance(provider, str) or not provider.strip():
            return False
        token = provider.strip()
        if token.lower() in ("auto", "gateway"):
            return any(p.get("enabled") for p in self.providers.values())
        if "/" in token:
            pid = token.split("/", 1)[0]
            return pid in self.providers and bool(self.providers[pid].get("enabled"))
        return token in self.providers and bool(self.providers[token].get("enabled"))

    def resolve_route(
        self,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        fallback: bool = True,
        profile: Optional[str] = None,
    ) -> Tuple[List[Tuple[str, str]], Optional[str]]:
        """Build ordered (provider_id, model_name) candidates plus optional browser fallback."""
        candidates: List[Tuple[str, str]] = []
        browser_fallback: Optional[str] = None
        seen = set()

        def _add_target(target: str, explicit_model: Optional[str] = None) -> None:
            nonlocal browser_fallback
            token = target.strip()
            if not token:
                return
            if token.startswith("browser:") or token.startswith("browser/"):
                bname = token.split(":", 1)[1] if ":" in token else token.split("/", 1)[1]
                if bname and browser_fallback is None:
                    browser_fallback = bname.strip().lower()
                return
            pid = token
            mname = explicit_model or ""
            if "/" in token and token.split("/", 1)[0] in self.providers:
                pid, mname = token.split("/", 1)
                if explicit_model:
                    mname = explicit_model
            cfg = self.providers.get(pid)
            if not cfg or not cfg.get("enabled"):
                return
            resolved_model = (mname or cfg.get("defaultModel") or "").strip()
            if not resolved_model:
                return
            key = (pid, resolved_model)
            if key not in seen:
                seen.add(key)
                candidates.append(key)

        raw_provider = (provider or "").strip()
        raw_model = (model or "").strip()

        # Support OpenAI-style model="browser/gemini" or "browser:gemini" when provider is omitted.
        if not raw_provider and (raw_model.startswith("browser/") or raw_model.startswith("browser:")):
            raw_provider, raw_model = raw_model, ""

        # Support OpenAI-style model="ollama/qwen2.5-coder:7b" when provider is omitted.
        if not raw_provider and "/" in raw_model:
            maybe_pid, maybe_model = raw_model.split("/", 1)
            if maybe_pid in self.providers:
                raw_provider, raw_model = maybe_pid, maybe_model

        explicit_browser = raw_provider.startswith("browser/") or raw_provider.startswith("browser:")

        if raw_provider and raw_provider.lower() not in ("auto", "gateway"):
            _add_target(raw_provider, raw_model or None)
        elif profile and isinstance(self.routing.get("subagentRouting", {}).get(profile), list):
            for entry in self.routing["subagentRouting"][profile]:
                if isinstance(entry, str):
                    _add_target(entry, raw_model or None)
        elif self.routing.get("defaultProvider"):
            _add_target(self.routing["defaultProvider"], raw_model or None)

        if fallback and not explicit_browser:
            for entry in self.routing.get("fallbackChain", []):
                if isinstance(entry, str):
                    _add_target(entry, None)
            # If still empty, include any enabled provider as a last-resort API candidate.
            if not candidates:
                for pid, cfg in self.providers.items():
                    if cfg.get("enabled"):
                        _add_target(pid, raw_model or None)
            if browser_fallback is None:
                default_browser = str(self.routing.get("defaultBrowserProvider") or "gemini").strip().lower()
                if default_browser:
                    browser_fallback = default_browser

        return candidates, browser_fallback

    async def chat_completion(
        self,
        messages: List[Dict[str, Any]],
        provider: Optional[str] = None,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        fallback: bool = True,
        timeout: float = 120.0,
        profile: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute an OpenAI-compatible chat completion with automatic fallback."""
        candidates, browser_fallback = self.resolve_route(
            provider=provider,
            model=model,
            fallback=fallback,
            profile=profile,
        )
        attempts: List[Dict[str, Any]] = []

        async def _try_browser() -> Optional[Dict[str, Any]]:
            if not browser_fallback or not self.browser_executor:
                return None
            started_b = time.monotonic()
            try:
                bres = await self.browser_executor(
                    provider=browser_fallback,
                    messages=messages,
                    timeout=timeout,
                )
            except Exception as berr:
                attempts.append(
                    {
                        "provider": f"browser/{browser_fallback}",
                        "model": browser_fallback,
                        "ok": False,
                        "error": str(berr) or type(berr).__name__,
                        "duration_ms": int((time.monotonic() - started_b) * 1000),
                    }
                )
                return None
            duration_b = int((time.monotonic() - started_b) * 1000)
            if isinstance(bres, dict) and bres.get("ok"):
                content_b = str(bres.get("content") or bres.get("result") or "")
                used_b = str(bres.get("provider") or browser_fallback)
                attempts.append(
                    {
                        "provider": f"browser/{used_b}",
                        "model": used_b,
                        "ok": True,
                        "duration_ms": duration_b,
                    }
                )
                return {
                    "ok": True,
                    "provider": "browser",
                    "model": used_b,
                    "content": content_b,
                    "message": {"role": "assistant", "content": content_b},
                    "usage": {},
                    "raw": bres,
                    "attempts": attempts,
                }
            err_b = (bres.get("error") if isinstance(bres, dict) else None) or "Browser extension execution failed."
            attempts.append(
                {
                    "provider": f"browser/{browser_fallback}",
                    "model": browser_fallback,
                    "ok": False,
                    "error": str(err_b),
                    "duration_ms": duration_b,
                }
            )
            return None

        if not candidates:
            browser_res = await _try_browser()
            if browser_res:
                return browser_res
            last_err = attempts[-1]["error"] if attempts else "No enabled OpenAI-compatible provider matched the request."
            return {
                "ok": False,
                "error": last_err,
                "attempts": attempts,
                "fallback_browser": browser_fallback,
            }
        for pid, mname in candidates:
            cfg = self.providers[pid]
            base_url = _resolve_env(cfg["baseUrl"]).rstrip("/")
            url = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
            api_key = _resolve_env(cfg.get("apiKey", ""))
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            for hk, hv in (cfg.get("headers") or {}).items():
                if isinstance(hk, str) and isinstance(hv, str):
                    headers[hk] = _resolve_env(hv)

            payload: Dict[str, Any] = {
                "model": mname,
                "messages": messages,
                "stream": False,
            }
            if temperature is not None:
                payload["temperature"] = temperature
            if max_tokens is not None:
                payload["max_tokens"] = max_tokens
            if tools:
                payload["tools"] = tools

            started = time.monotonic()
            try:
                status, data = await asyncio.to_thread(_http_post_json, url, headers, payload, timeout)
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError) as err:
                err_text = str(err).strip() or type(err).__name__
                attempts.append(
                    {
                        "provider": pid,
                        "model": mname,
                        "ok": False,
                        "error": err_text,
                        "duration_ms": int((time.monotonic() - started) * 1000),
                    }
                )
                self._log(f"[gateway] {pid}/{mname} failed: {err_text}")
                continue

            duration_ms = int((time.monotonic() - started) * 1000)
            if status >= 400 or not isinstance(data, dict) or not data.get("choices"):
                err_obj = data.get("error") if isinstance(data, dict) else str(data)
                if isinstance(err_obj, dict):
                    err_msg = str(err_obj.get("message") or err_obj)
                else:
                    err_msg = str(err_obj or f"HTTP {status}")
                attempts.append(
                    {
                        "provider": pid,
                        "model": mname,
                        "ok": False,
                        "status": status,
                        "error": err_msg,
                        "duration_ms": duration_ms,
                    }
                )
                self._log(f"[gateway] {pid}/{mname} HTTP {status}: {err_msg[:200]}")
                continue

            choice = data["choices"][0]
            message = choice.get("message") if isinstance(choice, dict) else {}
            content = message.get("content") if isinstance(message, dict) else ""
            if isinstance(content, list):
                content = "\n".join(
                    part.get("text", "") for part in content if isinstance(part, dict) and part.get("text")
                )
            attempts.append(
                {
                    "provider": pid,
                    "model": mname,
                    "ok": True,
                    "status": status,
                    "duration_ms": duration_ms,
                }
            )
            return {
                "ok": True,
                "provider": pid,
                "model": mname,
                "content": str(content or ""),
                "message": message if isinstance(message, dict) else {"role": "assistant", "content": str(content or "")},
                "usage": data.get("usage") if isinstance(data.get("usage"), dict) else {},
                "raw": data,
                "attempts": attempts,
            }

        browser_res = await _try_browser()
        if browser_res:
            return browser_res

        last_err = attempts[-1]["error"] if attempts else "All providers failed."
        return {
            "ok": False,
            "error": f"All API providers failed. Last error: {last_err}",
            "attempts": attempts,
            "fallback_browser": browser_fallback,
        }

    async def run_subagent(
        self,
        task: str,
        target_server: str,
        mcp_servers: Dict[str, Any],
        provider: Optional[str] = None,
        model: Optional[str] = None,
        allow_tools: bool = True,
        timeout: float = 180.0,
        max_turns: int = 8,
    ) -> Dict[str, Any]:
        """Run an isolated headless subagent via OpenAI-compatible API with optional MCP tool loop."""
        server = mcp_servers.get(target_server) if allow_tools else None
        openai_tools = _mcp_tools_to_openai(server.tools) if (server and server.alive and server.tools) else None

        system_prompt = (
            "You are a concise, autonomous Snapgent subagent delegated by a parent AI session. "
            "Complete the assigned task directly and return a clear final summary."
        )
        if openai_tools:
            system_prompt += f" You have access to MCP tools on target server '{target_server}'."

        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": task},
        ]

        deadline = time.monotonic() + max(10.0, timeout)
        active_provider = provider
        active_model = model
        last_provider = provider or ""
        last_model = model or ""

        for _turn in range(max_turns):
            remaining = deadline - time.monotonic()
            if remaining <= 2.0:
                return {
                    "ok": False,
                    "provider": last_provider,
                    "model": last_model,
                    "error": "Gateway subagent timed out.",
                }
            res = await self.chat_completion(
                messages=messages,
                provider=active_provider,
                model=active_model,
                tools=openai_tools,
                fallback=(_turn == 0),
                timeout=min(remaining, 120.0),
            )
            if not res.get("ok"):
                return {
                    "ok": False,
                    "provider": last_provider,
                    "model": last_model,
                    "error": res.get("error") or "Gateway subagent failed.",
                    "fallback_browser": res.get("fallback_browser"),
                    "attempts": res.get("attempts", []),
                }

            last_provider = res["provider"]
            last_model = res["model"]
            active_provider = last_provider
            active_model = last_model
            assistant_msg = res["message"]
            tool_calls = assistant_msg.get("tool_calls") if isinstance(assistant_msg, dict) else None

            if not tool_calls or not server or not server.alive:
                return {
                    "ok": True,
                    "provider": last_provider,
                    "model": last_model,
                    "result": str(res.get("content") or "").strip(),
                    "via": "gateway",
                }

            messages.append(assistant_msg)
            for call in tool_calls:
                call_id = str(call.get("id") or f"call_{uuid.uuid4().hex[:8]}")
                fn = call.get("function") if isinstance(call, dict) else {}
                tool_name = str(fn.get("name") or "")
                raw_args = fn.get("arguments")
                if isinstance(raw_args, str):
                    try:
                        parsed_args = json.loads(raw_args) if raw_args.strip() else {}
                    except json.JSONDecodeError:
                        parsed_args = {}
                elif isinstance(raw_args, dict):
                    parsed_args = raw_args
                else:
                    parsed_args = {}

                try:
                    tool_res = await server.call_tool(tool_name, parsed_args, min(max(5.0, deadline - time.monotonic()), 60.0))
                    text_parts = [
                        item.get("text", "")
                        for item in tool_res.get("content", [])
                        if isinstance(item, dict) and item.get("type") == "text"
                    ]
                    tool_text = "\n".join(text_parts) or json.dumps(tool_res, ensure_ascii=False)
                except Exception as err:
                    tool_text = f"ERROR: {err}"

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "name": tool_name,
                        "content": tool_text[:32000],
                    }
                )

        return {
            "ok": False,
            "provider": last_provider,
            "model": last_model,
            "error": f"Gateway subagent reached max turns ({max_turns}) without a final answer.",
        }

    def update_config(
        self,
        provider_id: Optional[str] = None,
        provider_config: Optional[Dict[str, Any]] = None,
        remove: bool = False,
        routing: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Persist aiProviders / routing changes atomically to config.json and reload."""
        data = json.loads(self.config_path.read_text(encoding="utf-8")) if self.config_path.exists() else {}
        if not isinstance(data, dict):
            raise RuntimeError("config.json root must be a JSON object.")
        providers = data.setdefault("aiProviders", {})
        if not isinstance(providers, dict):
            raise RuntimeError("aiProviders must be a JSON object.")

        if provider_id is not None:
            if not isinstance(provider_id, str) or not PROVIDER_ID_PATTERN.fullmatch(provider_id):
                raise RuntimeError("Invalid AI provider id.")
            if remove:
                providers.pop(provider_id, None)
            else:
                if not isinstance(provider_config, dict):
                    raise RuntimeError("Provider configuration object is required.")
                base_url = str(provider_config.get("baseUrl") or "").strip()
                if not base_url:
                    raise RuntimeError("Provider baseUrl is required.")
                providers[provider_id] = {
                    "type": str(provider_config.get("type") or "openai").strip().lower(),
                    "baseUrl": base_url,
                    "apiKey": str(provider_config.get("apiKey") or ""),
                    "models": [str(m) for m in provider_config.get("models", []) if isinstance(m, str) and m.strip()],
                    "defaultModel": str(provider_config.get("defaultModel") or "").strip(),
                    "enabled": bool(provider_config.get("enabled", True)),
                }

        if routing is not None:
            if not isinstance(routing, dict):
                raise RuntimeError("routing must be a JSON object.")
            data["routing"] = routing

        tmp = self.config_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(self.config_path)
        self.reload()


def _http_response(
    status: int,
    reason: str,
    body: bytes,
    content_type: str = "application/json; charset=utf-8",
) -> bytes:
    headers = [
        f"HTTP/1.1 {status} {reason}",
        f"Content-Type: {content_type}",
        f"Content-Length: {len(body)}",
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Methods: GET, POST, OPTIONS",
        "Access-Control-Allow-Headers: Content-Type, Authorization",
        "Connection: close",
    ]
    return ("\r\n".join(headers) + "\r\n\r\n").encode("utf-8") + body


async def start_http_gateway(bridge: Any, host: str, port: int) -> asyncio.AbstractServer:
    """Start a lightweight asyncio HTTP/1.1 OpenAI-compatible gateway server."""

    async def _handle_http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            header_bytes = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
            writer.close()
            return

        try:
            header_text = header_bytes.decode("utf-8", errors="replace")
            lines = header_text.split("\r\n")
            request_line = lines[0].split(" ")
            if len(request_line) < 2:
                writer.write(_http_response(400, "Bad Request", b'{"error":"Malformed HTTP request"}'))
                await writer.drain()
                return
            method = request_line[0].upper()
            path = request_line[1].split("?", 1)[0]

            headers: Dict[str, str] = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            content_length = int(headers.get("content-length", "0") or "0")
            body_bytes = b""
            if content_length > 0:
                if content_length > 16 * 1024 * 1024:
                    writer.write(_http_response(413, "Payload Too Large", b'{"error":"Payload too large"}'))
                    await writer.drain()
                    return
                body_bytes = await asyncio.wait_for(reader.readexactly(content_length), timeout=30.0)

            if method == "OPTIONS":
                writer.write(_http_response(204, "No Content", b""))
                await writer.drain()
                return

            if method == "GET" and path == "/health":
                payload = {
                    "ok": True,
                    "providers": bridge.gateway.list_providers(),
                    "routing": bridge.gateway.routing,
                }
                writer.write(_http_response(200, "OK", json.dumps(payload).encode("utf-8")))
                await writer.drain()
                return

            if method == "GET" and path == "/v1/providers":
                payload = {
                    "providers": bridge.gateway.list_providers(),
                    "routing": bridge.gateway.routing,
                }
                writer.write(_http_response(200, "OK", json.dumps(payload).encode("utf-8")))
                await writer.drain()
                return

            if method == "GET" and path == "/v1/models":
                payload = {"object": "list", "data": bridge.gateway.list_models()}
                writer.write(_http_response(200, "OK", json.dumps(payload).encode("utf-8")))
                await writer.drain()
                return

            if method == "POST" and path == "/v1/chat/completions":
                try:
                    req_json = json.loads(body_bytes.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    writer.write(_http_response(400, "Bad Request", b'{"error":{"message":"Invalid JSON body"}}'))
                    await writer.drain()
                    return
                messages = req_json.get("messages")
                if not isinstance(messages, list) or not messages:
                    writer.write(_http_response(400, "Bad Request", b'{"error":{"message":"messages array is required"}}'))
                    await writer.drain()
                    return
                stream = bool(req_json.get("stream"))
                result = await bridge.gateway.chat_completion(
                    messages=messages,
                    provider=req_json.get("provider"),
                    model=req_json.get("model"),
                    temperature=req_json.get("temperature"),
                    max_tokens=req_json.get("max_tokens"),
                    tools=req_json.get("tools"),
                    fallback=req_json.get("fallback", True),
                )
                if not result.get("ok"):
                    err_payload = {
                        "error": {
                            "message": result.get("error") or "Gateway error",
                            "type": "gateway_error",
                            "attempts": result.get("attempts", []),
                        }
                    }
                    writer.write(_http_response(502, "Bad Gateway", json.dumps(err_payload).encode("utf-8")))
                    await writer.drain()
                    return

                completion_id = f"chatcmpl-{uuid.uuid4().hex[:16]}"
                created = int(time.time())
                model_label = f"{result['provider']}/{result['model']}"

                if stream:
                    chunk = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_label,
                        "choices": [
                            {"index": 0, "delta": {"role": "assistant", "content": result["content"]}, "finish_reason": None}
                        ],
                    }
                    done_chunk = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_label,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    }
                    sse_body = (
                        f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        f"data: {json.dumps(done_chunk, ensure_ascii=False)}\n\n"
                        "data: [DONE]\n\n"
                    ).encode("utf-8")
                    writer.write(_http_response(200, "OK", sse_body, content_type="text/event-stream; charset=utf-8"))
                    await writer.drain()
                    return

                resp_payload = {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model_label,
                    "choices": [
                        {"index": 0, "message": result["message"], "finish_reason": "stop"}
                    ],
                    "usage": result.get("usage") or {},
                    "snapgent_meta": {
                        "provider": result["provider"],
                        "model": result["model"],
                        "attempts": result.get("attempts", []),
                    },
                }
                writer.write(_http_response(200, "OK", json.dumps(resp_payload, ensure_ascii=False).encode("utf-8")))
                await writer.drain()
                return

            writer.write(_http_response(404, "Not Found", b'{"error":{"message":"Not found"}}'))
            await writer.drain()
        except Exception as err:
            err_body = json.dumps({"error": {"message": str(err)}}).encode("utf-8")
            try:
                writer.write(_http_response(500, "Internal Server Error", err_body))
                await writer.drain()
            except OSError:
                pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except OSError:
                pass

    return await asyncio.start_server(_handle_http, host, port, reuse_address=True)
