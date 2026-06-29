import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  getTask,
  listRuns,
  loadEnv,
  logger,
  setCancelFlag,
  setTaskState,
  TERMINAL_STATES,
} from "@kotx/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Gate UI/API routes behind HTTP Basic auth (password == UI_TOKEN). Returns
 *  false (and sends a response) when access is denied or the UI is disabled. */
function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env.UI_TOKEN;
  if (!token) {
    reply.code(503).send("UI disabled: set UI_TOKEN to enable it.");
    return false;
  }
  const hdr = req.headers.authorization;
  if (hdr?.startsWith("Basic ")) {
    const decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (eq(pass, token)) return true;
  }
  reply
    .code(401)
    .header("WWW-Authenticate", 'Basic realm="kotx"')
    .send("authentication required");
  return false;
}

function githubUrl(
  repo: string,
  subjectType: string,
  subjectNumber: number,
): string {
  const kind = subjectType === "pull_request" ? "pull" : "issues";
  return `https://github.com/${repo}/${kind}/${subjectNumber}`;
}

export function registerUi(app: FastifyInstance): void {
  app.get("/", async (_req, reply) => reply.redirect("/ui"));

  app.get("/ui", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    return reply.type("text/html").send(PAGE);
  });

  app.get("/api/runs", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const rows = await listRuns(200);
    return rows.map((r) => ({
      runId: r.run_id,
      taskId: r.task_id,
      repo: r.repo_full_name,
      subjectType: r.subject_type,
      subjectNumber: r.subject_number,
      kind: r.kind,
      state: r.state,
      attempt: r.attempt,
      outcome: r.outcome,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      updatedAt: r.updated_at,
      githubUrl: githubUrl(r.repo_full_name, r.subject_type, r.subject_number),
      canStop: r.state === "queued" || r.state === "running",
    }));
  });

  app.get("/api/runs/:id/task", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0)
      return reply.code(400).send("bad run id");
    const path = join(loadEnv().agentDataDir, "runs", String(id), "TASK.md");
    try {
      const text = await readFile(path, "utf8");
      return reply.type("text/plain").send(text);
    } catch {
      return reply.code(404).send("TASK.md not found for this run");
    }
  });

  app.post("/api/tasks/:id/stop", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0)
      return reply.code(400).send("bad task id");
    const task = await getTask(id);
    if (!task) return reply.code(404).send("no such task");
    if (TERMINAL_STATES.has(task.state))
      return reply.code(409).send(`task already ${task.state}`);
    await setCancelFlag(id);
    if (task.state === "queued") await setTaskState(id, "cancelled");
    logger.info({ taskId: id }, "stop requested from UI");
    return { ok: true };
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>kotx runs</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 1rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .75rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8884; white-space: nowrap; }
  th { font-weight: 600; }
  .muted { opacity: .6; }
  .badge { padding: .1rem .45rem; border-radius: 999px; font-size: .8rem; }
  .running { background: #2d7; color: #042; }
  .queued { background: #79f; color: #014; }
  .done { background: #8c8a; }
  .failed, .timed_out { background: #e55; color: #fff; }
  .cancelled { background: #aaa6; }
  button { font: inherit; padding: .2rem .5rem; cursor: pointer; }
  a { color: inherit; }
  #overlay { position: fixed; inset: 0; background: #000a; display: none; align-items: center; justify-content: center; }
  #modal { background: Canvas; color: CanvasText; max-width: 90vw; max-height: 85vh; overflow: auto; padding: 1rem; border-radius: 8px; }
  #modal pre { white-space: pre-wrap; word-break: break-word; }
  .row-actions button { margin-right: .3rem; }
</style>
</head>
<body>
<h1>kotx runs <span class="muted" id="ts"></span></h1>
<table>
  <thead><tr>
    <th>Run</th><th>Repo / Subject</th><th>Kind</th><th>State</th>
    <th>Outcome</th><th>Updated</th><th>Actions</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>

<div id="overlay" onclick="if(event.target===this)this.style.display='none'">
  <div id="modal"><h3 id="modal-title"></h3><pre id="modal-body"></pre>
  <button onclick="document.getElementById('overlay').style.display='none'">Close</button></div>
</div>

<script>
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function fmt(t){return t?new Date(t).toLocaleString():'';}

async function load(){
  var res = await fetch('/api/runs');
  if(!res.ok){return;}
  var runs = await res.json();
  var tb = document.getElementById('rows');
  tb.innerHTML = runs.map(function(r){
    var subj = (r.subjectType==='pull_request'?'PR':'Issue')+' #'+r.subjectNumber;
    var stop = r.canStop ? '<button onclick="stopTask('+r.taskId+')">Stop</button>' : '';
    return '<tr>'
      + '<td>'+r.runId+(r.attempt>1?(' <span class="muted">(att '+r.attempt+')</span>'):'')+'</td>'
      + '<td><span class="muted">'+esc(r.repo)+'</span><br><a href="'+esc(r.githubUrl)+'" target="_blank" rel="noopener">'+subj+'</a></td>'
      + '<td>'+esc(r.kind)+'</td>'
      + '<td><span class="badge '+esc(r.state)+'">'+esc(r.state)+'</span></td>'
      + '<td>'+esc(r.outcome||'')+'</td>'
      + '<td class="muted">'+esc(fmt(r.updatedAt))+'</td>'
      + '<td class="row-actions"><button onclick="viewTask('+r.runId+')">TASK.md</button>'+stop+'</td>'
      + '</tr>';
  }).join('');
  document.getElementById('ts').textContent = 'updated '+new Date().toLocaleTimeString();
}

async function viewTask(runId){
  var res = await fetch('/api/runs/'+runId+'/task');
  var text = await res.text();
  document.getElementById('modal-title').textContent = 'TASK.md — run '+runId;
  document.getElementById('modal-body').textContent = text;
  document.getElementById('overlay').style.display = 'flex';
}

async function stopTask(taskId){
  if(!confirm('Stop task #'+taskId+'?')) return;
  await fetch('/api/tasks/'+taskId+'/stop', {method:'POST'});
  load();
}

load();
setInterval(load, 5000);
</script>
</body>
</html>`;
