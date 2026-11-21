import asyncio
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace

import ai_gateway


class _MockOpenAIHandler(BaseHTTPRequestHandler):
    fail_once = False
    tool_mode = False
    call_count = 0

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        _MockOpenAIHandler.call_count += 1

        if _MockOpenAIHandler.fail_once:
            _MockOpenAIHandler.fail_once = False
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": {"message": "Service temporarily unavailable"}}).encode("utf-8"))
            return

        messages = body.get("messages", [])
        has_tool_result = any(m.get("role") == "tool" for m in messages)

        if _MockOpenAIHandler.tool_mode and not has_tool_result:
            resp = {
                "id": "chatcmpl-tool",
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "echo",
                                        "arguments": json.dumps({"message": "hello-from-mcp"}),
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            }
        else:
            last_content = messages[-1].get("content", "") if messages else ""
            resp = {
                "id": "chatcmpl-ok",
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": f"mock-reply:{last_content}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
            }

        raw = json.dumps(resp).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class AIGatewayTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock_server = HTTPServer(("127.0.0.1", 0), _MockOpenAIHandler)
        cls.mock_port = cls.mock_server.server_address[1]
        cls.mock_thread = threading.Thread(target=cls.mock_server.serve_forever, daemon=True)
        cls.mock_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.mock_server.shutdown()
        cls.mock_server.server_close()

    def setUp(self):
        _MockOpenAIHandler.fail_once = False
        _MockOpenAIHandler.tool_mode = False
        _MockOpenAIHandler.call_count = 0

    def _make_config(self, root: Path, extra=None) -> Path:
        cfg = {
            "mcpServers": {},
            "aiProviders": {
                "primary": {
                    "type": "openai",
                    "baseUrl": f"http://127.0.0.1:{self.mock_port}/v1",
                    "apiKey": "${TEST_GW_KEY}",
                    "models": ["model-a"],
                    "defaultModel": "model-a",
                    "enabled": True,
                },
                "backup": {
                    "type": "openai",
                    "baseUrl": f"http://127.0.0.1:{self.mock_port}/v1",
                    "apiKey": "backup-key",
                    "models": ["model-b"],
                    "defaultModel": "model-b",
                    "enabled": True,
                },
            },
            "routing": {
                "defaultProvider": "primary",
                "fallbackChain": ["primary", "backup", "browser:gemini"],
                "subagentRouting": {"fast": ["primary", "browser:deepseek"]},
            },
        }
        if extra:
            cfg.update(extra)
        path = root / "config.json"
        path.write_text(json.dumps(cfg), encoding="utf-8")
        return path

    async def test_fallback_chain_and_browser_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = self._make_config(Path(tmp))
            os.environ["TEST_GW_KEY"] = "secret-123"
            gw = ai_gateway.AIGateway(cfg_path)

            # Primary fails with 503 -> automatically falls back to backup.
            _MockOpenAIHandler.fail_once = True
            res = await gw.chat_completion(messages=[{"role": "user", "content": "ping"}])
            self.assertTrue(res["ok"])
            self.assertEqual(res["provider"], "backup")
            self.assertEqual(res["model"], "model-b")
            self.assertEqual(len(res["attempts"]), 2)
            self.assertFalse(res["attempts"][0]["ok"])
            self.assertTrue(res["attempts"][1]["ok"])

            # Browser fallback target is preserved in route resolution.
            candidates, browser_fb = gw.resolve_route(provider="primary", fallback=True)
            self.assertEqual(candidates, [("primary", "model-a"), ("backup", "model-b")])
            self.assertEqual(browser_fb, "gemini")

    async def test_headless_subagent_with_mcp_tool_loop(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = self._make_config(Path(tmp))
            gw = ai_gateway.AIGateway(cfg_path)
            _MockOpenAIHandler.tool_mode = True

            called = []

            async def fake_call_tool(name, args, timeout):
                called.append((name, args))
                return {"content": [{"type": "text", "text": args.get("message", "")}], "isError": False}

            fake_server = SimpleNamespace(
                alive=True,
                tools=[{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}}}],
                call_tool=fake_call_tool,
            )

            res = await gw.run_subagent(
                task="Run echo",
                target_server="mock",
                mcp_servers={"mock": fake_server},
                provider="primary",
            )
            self.assertTrue(res["ok"])
            self.assertEqual(res["via"], "gateway")
            self.assertEqual(called, [("echo", {"message": "hello-from-mcp"})])
            self.assertIn("hello-from-mcp", res["result"])

    async def test_http_gateway_endpoints(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = self._make_config(Path(tmp))
            gw = ai_gateway.AIGateway(cfg_path)
            fake_bridge = SimpleNamespace(gateway=gw)
            server = await ai_gateway.start_http_gateway(fake_bridge, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                def _get(url):
                    with urllib.request.urlopen(url, timeout=5) as r:
                        return r.status, json.loads(r.read().decode("utf-8"))

                status, models_data = await asyncio.to_thread(_get, f"http://127.0.0.1:{port}/v1/models")
                self.assertEqual(status, 200)
                ids = [m["id"] for m in models_data["data"]]
                self.assertIn("primary/model-a", ids)
                self.assertIn("browser/gemini", ids)

                def _post(url, payload):
                    req = urllib.request.Request(
                        url,
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=5) as r:
                        return r.status, r.read().decode("utf-8")

                st, raw = await asyncio.to_thread(
                    _post,
                    f"http://127.0.0.1:{port}/v1/chat/completions",
                    {"model": "primary/model-a", "messages": [{"role": "user", "content": "hi"}]},
                )
                self.assertEqual(st, 200)
                parsed = json.loads(raw)
                self.assertEqual(parsed["choices"][0]["message"]["content"], "mock-reply:hi")

                st_sse, raw_sse = await asyncio.to_thread(
                    _post,
                    f"http://127.0.0.1:{port}/v1/chat/completions",
                    {"model": "primary/model-a", "stream": True, "messages": [{"role": "user", "content": "hi"}]},
                )
                self.assertEqual(st_sse, 200)
                self.assertIn("data: [DONE]", raw_sse)
            finally:
                server.close()
                await server.wait_closed()


if __name__ == "__main__":
    unittest.main()
