/**
 * Localhost approval web UI — a single self-contained page served at /ui.
 *
 * The API token is embedded server-side. That is a deliberate trust call, not
 * an accident: the page is only reachable from this machine (loopback bind +
 * Host-header validation in server.ts), and any process that can fetch it
 * could equally read ~/.clawguard/token — same user, same boundary. Foreign
 * websites can't read it: cross-origin responses are unreadable without CORS
 * headers (we send none), and DNS-rebinding is blocked by the Host check.
 */
export function renderApprovalsPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClawGuard — approvals</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0d1117; color: #e6edf3; min-height: 100vh; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 20px 24px;
           border-bottom: 1px solid #21262d; }
  header h1 { font-size: 18px; margin: 0; }
  header .sub { color: #8b949e; font-size: 13px; }
  main { max-width: 720px; margin: 0 auto; padding: 24px; }
  .empty { text-align: center; color: #8b949e; padding: 64px 0; font-size: 15px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
          padding: 16px; margin-bottom: 14px; }
  .card.decided { opacity: 0.55; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .who { font-weight: 600; font-size: 14px; }
  .timer { color: #d29922; font-variant-numeric: tabular-nums; font-size: 13px; }
  .summary { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
             font-size: 13px; color: #c9d1d9; background: #0d1117; border-radius: 6px;
             padding: 10px 12px; margin: 10px 0; word-break: break-all;
             border: 1px solid #21262d; }
  .code { color: #8b949e; font-size: 12px; }
  .btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  button { border: 1px solid #30363d; border-radius: 8px; padding: 8px 14px;
           font-size: 13px; cursor: pointer; background: #21262d; color: #e6edf3; }
  button:hover { filter: brightness(1.25); }
  .approve { background: #1a7f37; border-color: #2ea043; }
  .deny { background: #b62324; border-color: #da3633; }
  .always { background: #1f6feb22; border-color: #1f6feb; }
  .outcome { font-weight: 600; margin-top: 8px; font-size: 13px; }
  footer { text-align: center; color: #484f58; font-size: 12px; padding: 24px; }
</style>
</head>
<body>
<header>
  <h1>🛡️ ClawGuard</h1>
  <span class="sub">approvals — auto-deny on timeout, always</span>
</header>
<main>
  <div id="list"></div>
  <div id="empty" class="empty">Nothing waiting. Your agent is behaving.</div>
</main>
<footer>loopback only · tamper-evident audit · deny is the default</footer>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const HEADERS = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
  const decided = new Map(); // id -> outcome label, kept so cards fade instead of vanishing

  async function decide(id, verdict, always) {
    const res = await fetch("/v1/decisions", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ id, verdict, always, approver: "web-ui" }),
    });
    decided.set(id, res.ok ? (always ? "📌 always allowed" : verdict === "allow" ? "✅ approved" : "⛔ denied")
                           : "already decided or expired");
    render(lastPending);
  }

  let lastPending = [];
  let renderedKey = "";
  function updateTimers() {
    for (const t of document.querySelectorAll(".timer[data-expires]")) {
      const secs = Math.max(0, Math.round((Number(t.dataset.expires) - Date.now()) / 1000));
      t.textContent = "auto-deny in " + secs + "s";
    }
  }
  function render(pending) {
    lastPending = pending;
    const list = document.getElementById("list");
    document.getElementById("empty").style.display = pending.length ? "none" : "block";
    // Rebuild the DOM only when the set of cards actually changes — a wholesale
    // re-render every poll would yank buttons out from under the user's click.
    const key = JSON.stringify(pending.map(p => p.request.id)) + "|" + JSON.stringify([...decided.keys()]);
    if (key === renderedKey) return updateTimers();
    renderedKey = key;
    list.replaceChildren(...pending.map(p => {
      const el = document.createElement("div");
      const done = decided.get(p.request.id);
      el.className = "card" + (done ? " decided" : "");
      const secs = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      el.innerHTML =
        '<div class="row"><span class="who"></span><span class="timer" data-expires="' + p.expiresAt + '">auto-deny in ' + secs + 's</span></div>' +
        '<div class="summary"></div>' +
        '<div class="code">code ' + p.code + "</div>";
      el.querySelector(".who").textContent = p.request.agent + " wants " + p.request.tool;
      el.querySelector(".summary").textContent = JSON.stringify(p.request.params);
      if (done) el.querySelector(".timer").remove(); // decided cards stop counting down
      if (done) {
        const o = document.createElement("div");
        o.className = "outcome";
        o.textContent = done;
        el.appendChild(o);
      } else {
        const btns = document.createElement("div");
        btns.className = "btns";
        for (const [label, cls, verdict, always] of [
          ["✅ Approve", "approve", "allow", false],
          ["⛔ Deny", "deny", "deny", false],
          ["📌 Always allow this exact action", "always", "allow", true],
        ]) {
          const b = document.createElement("button");
          b.className = cls;
          b.textContent = label;
          b.onclick = () => decide(p.request.id, verdict, always);
          btns.appendChild(b);
        }
        el.appendChild(btns);
      }
      return el;
    }));
  }

  async function poll() {
    try {
      const res = await fetch("/v1/pending", { headers: HEADERS });
      if (res.ok) render((await res.json()).pending ?? []);
    } catch { /* daemon restarting — keep polling */ }
  }
  poll();
  setInterval(poll, 1500);
</script>
</body>
</html>`;
}
