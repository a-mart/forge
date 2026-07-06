// E2E bootstrap: create a manager profile over the CLI WS (deleted after Wave gates).
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
const key = readFileSync(process.env.HOME + "/.forge-v2-test/.e2e-cli-key", "utf8").trim();
const name = process.argv[2] ?? "e2e-wave0";
const cwd = process.argv[3] ?? "/tmp/forge-e2e-playground";
const ws = new WebSocket("ws://127.0.0.1:47387", { headers: { authorization: `Bearer ${key}` } });
const requestId = "e2e-" + Date.now();
setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 30000);
ws.on("open", () => { ws.send(JSON.stringify({ type: "subscribe" })); setTimeout(() => ws.send(JSON.stringify({ type: "create_manager", name, cwd, requestId })), 500); });
ws.on("message", (raw) => {
  const ev = JSON.parse(String(raw));
  if (ev.requestId !== requestId) return;
  console.log(JSON.stringify(ev, null, 2).slice(0, 600));
  process.exit(ev.ok === false || ev.type === "error" ? 1 : 0);
});
ws.on("error", (e) => { console.error("WS ERROR: " + e.message); process.exit(1); });
