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

  nav { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid #21262d; }
  nav button { border: none; border-bottom: 2px solid transparent; border-radius: 0;
               background: none; color: #8b949e; padding: 10px 14px; font-size: 14px; }
  nav button.on { color: #e6edf3; border-bottom-color: #f78166; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
           font-weight: 600; letter-spacing: .02em; }
  .ok { background: #1a7f3733; color: #3fb950; border: 1px solid #2ea04366; }
  .bad { background: #b6232433; color: #f85149; border: 1px solid #da363366; }
  .chainbar { display: flex; justify-content: space-between; align-items: center;
              margin-bottom: 14px; font-size: 12px; color: #8b949e; }
  .h { display: grid; grid-template-columns: 62px 1fr auto; gap: 10px; align-items: baseline;
       padding: 9px 12px; border-bottom: 1px solid #21262d; font-size: 13px; }
  .h:hover { background: #161b22; }
  .h time { color: #6e7681; font-variant-numeric: tabular-nums; font-size: 12px; }
  .h .what { min-width: 0; }
  .h .tool { font-weight: 600; }
  .h .prm { color: #8b949e; font-family: ui-monospace, Consolas, monospace; font-size: 12px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
  .h .by { color: #6e7681; font-size: 11px; }
  .v { font-size: 11px; font-weight: 700; white-space: nowrap; }
  .v-allow { color: #3fb950; } .v-deny { color: #f85149; } .v-info { color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>🛡️ ClawGuard</h1>
  <span class="sub">approvals — auto-deny on timeout, always</span>
</header>
<nav>
  <button id="tab-pending" class="on" onclick="showTab('pending')">Pending</button>
  <button id="tab-history" onclick="showTab('history')">History</button>
</nav>
<main>
  <div id="view-pending">
    <div id="list"></div>
    <div id="empty" class="empty">Nothing waiting. Your agent is behaving.</div>
  </div>
  <div id="view-history" style="display:none">
    <div class="chainbar">
      <span id="chain"></span>
      <span>
        <label><input type="checkbox" id="showall" onchange="loadHistory()"> daemon events</label>
        &nbsp;<span id="count"></span>
      </span>
    </div>
    <div id="hlist"></div>
  </div>
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

  let tab = "pending";
  function showTab(name) {
    tab = name;
    document.getElementById("view-pending").style.display = name === "pending" ? "" : "none";
    document.getElementById("view-history").style.display = name === "history" ? "" : "none";
    document.getElementById("tab-pending").className = name === "pending" ? "on" : "";
    document.getElementById("tab-history").className = name === "history" ? "on" : "";
    if (name === "history") loadHistory();
  }

  const VERDICT = {
    allow: ["ALLOWED", "v-allow"], deny: ["BLOCKED", "v-deny"],
  };
  function verdictOf(r) {
    if (r.kind === "observed") return ["EXECUTED", "v-info"];
    if (r.kind === "remembered") return ["REMEMBERED", "v-info"];
    if (r.kind === "started") return ["STARTED", "v-info"];
    if (!r.verdict) return ["PENDING", "v-info"];
    return VERDICT[r.verdict] ?? ["?", "v-info"];
  }
  function whoDecided(r) {
    if (r.kind !== "gated") return r.approver ? "by " + r.approver : "";
    if (r.decidedBy === "human") return "you (" + (r.approver || "?") + ")";
    if (r.decidedBy === "timeout") return "timed out — auto-denied";
    if (r.decidedBy === "remembered") return "remembered rule";
    return r.rule || r.reason || "policy";
  }

  async function loadHistory() {
    try {
      const res = await fetch("/v1/history?limit=200", { headers: HEADERS });
      if (!res.ok) return;
      const h = await res.json();
      document.getElementById("chain").innerHTML = h.chain.ok
        ? '<span class="badge ok">chain verified</span> ' + h.chain.entries + ' entries, unedited'
        : '<span class="badge bad">CHAIN BROKEN</span> tampering detected at entry ' + h.chain.brokenAt;

      // Daemon restarts are noise next to agent activity — hidden unless asked for.
      const showAll = document.getElementById("showall").checked;
      const rows = showAll ? h.rows : h.rows.filter(r => r.kind !== "started");
      document.getElementById("count").textContent = rows.length + " of " + h.total + " actions";

      const list = document.getElementById("hlist");
      if (rows.length === 0) {
        list.innerHTML = '<div class="empty">No agent activity recorded yet.</div>';
        return;
      }
      list.replaceChildren(...rows.map(r => {
        const el = document.createElement("div");
        el.className = "h";
        const [label, cls] = verdictOf(r);
        el.innerHTML = '<time></time><div class="what"><span class="tool"></span>' +
          '<span class="prm"></span><span class="by"></span></div>' +
          '<span class="v ' + cls + '"></span>';
        el.querySelector("time").textContent = new Date(r.ts).toLocaleTimeString();
        el.querySelector(".tool").textContent =
          r.kind === "started" ? "ClawGuard started" : (r.agent || "?") + " · " + (r.tool || "?");
        el.querySelector(".prm").textContent = r.params ? JSON.stringify(r.params) : "";
        el.querySelector(".by").textContent = whoDecided(r);
        el.querySelector(".v").textContent = label;
        return el;
      }));
    } catch { /* daemon restarting */ }
  }

  async function poll() {
    try {
      const res = await fetch("/v1/pending", { headers: HEADERS });
      if (res.ok) render((await res.json()).pending ?? []);
    } catch { /* daemon restarting — keep polling */ }
    if (tab === "history") loadHistory();
  }
  poll();
  setInterval(poll, 1500);
</script>
</body>
</html>`;
}
