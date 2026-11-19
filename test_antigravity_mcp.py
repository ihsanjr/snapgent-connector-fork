import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER_SCRIPT = ROOT / "antigravity_mcp.py"
TEST_FILE = "_mcp_smoke_test.tmp"


class McpClient:
    def __init__(self, script_path: Path):
        self.proc = subprocess.Popen(
            [sys.executable, str(script_path)],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._req_id = 0

    def send_notification(self, method: str, params: dict | None = None):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None) -> dict:
        self._req_id += 1
        req_id = self._req_id
        payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

        while True:
            line = self.proc.stdout.readline()
            if not line:
                err = self.proc.stderr.read()
                raise RuntimeError(f"Server berhenti tanpa respons.\nSTDERR:\n{err}")
            msg = json.loads(line)
            if msg.get("id") == req_id:
                if "error" in msg:
                    raise RuntimeError(f"RPC Error pada {method}: {msg['error']}")
                return msg["result"]

    def call_tool(self, name: str, arguments: dict) -> str:
        res = self.request("tools/call", {"name": name, "arguments": arguments})
        if res.get("isError"):
            raise RuntimeError(f"Tool '{name}' mengembalikan error: {res}")
        blocks = res.get("content", [])
        return "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=5)


def run_tests():
    if not SERVER_SCRIPT.exists():
        raise FileNotFoundError(f"Tidak ditemukan: {SERVER_SCRIPT}")

    client = McpClient(SERVER_SCRIPT)
    try:
        init_res = client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "antigravity-smoke-test", "version": "1.0"},
            },
        )
        client.send_notification("notifications/initialized")
        print(f"[PASS] initialize -> server: {init_res.get('serverInfo', {})}")

        tools_res = client.request("tools/list", {})
        tool_names = {t["name"] for t in tools_res.get("tools", [])}
        print(f"[PASS] tools/list -> {len(tool_names)} tools tersedia")

        required_tools = {"list_dir", "read_file", "write_file", "edit_file", "delete_file"}
        missing = required_tools - tool_names
        if missing:
            raise AssertionError(f"Tool wajib tidak ditemukan: {sorted(missing)}")

        try:
            dir_out = client.call_tool("list_dir", {"path": "."})
        except RuntimeError as e:
            if "Open a project folder in Antigravity IDE" in str(e):
                print("[PASS] workspace guard -> Antigravity IDE belum membuka folder proyek (guard aktif)")
                print("\nPengujian protokol & guard antigravity_mcp.py BERHASIL.")
                return
            raise

        print(f"[PASS] list_dir -> workspace aktif ({len(dir_out.splitlines())} entri)")

        client.call_tool("write_file", {"path": TEST_FILE, "content": "baris 1\nbaris 2\n"})
        read_out = client.call_tool("read_file", {"path": TEST_FILE})
        assert "baris 1" in read_out, "Isi write_file tidak sesuai saat dibaca"
        print("[PASS] write_file & read_file -> sukses")

        client.call_tool(
            "edit_file",
            {"path": TEST_FILE, "old_text": "baris 2", "new_text": "baris 2 edited"},
        )
        edited_out = client.call_tool("read_file", {"path": TEST_FILE})
        assert "baris 2 edited" in edited_out, "Perubahan edit_file tidak tersimpan"
        print("[PASS] edit_file -> sukses")

        if "git_status" in tool_names:
            git_out = client.call_tool("git_status", {})
            print(f"[PASS] git_status -> {git_out.splitlines()[0] if git_out else 'OK'}")

        print("\nSemua pengujian penuh antigravity_mcp.py BERHASIL.")
    finally:
        try:
            if (ROOT / TEST_FILE).exists():
                client.call_tool("delete_file", {"path": TEST_FILE})
                print("[CLEANUP] File sementara dihapus via delete_file.")
        except Exception:
            (ROOT / TEST_FILE).unlink(missing_ok=True)
        client.close()


if __name__ == "__main__":
    run_tests()