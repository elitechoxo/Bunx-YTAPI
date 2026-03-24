import { join }                  from "path";
import { unlink, mkdir, access } from "fs/promises";
import { constants }             from "fs";
import {
  initCookies, list as listCookies, getActivePath,
  saveCookie, deleteCookie, testCookie, testAll, testRun,
  rotateOnError,
} from "./static/cookies.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT)             || 8080;
const BASE_URL         = process.env.BASE_URL                   || `http://localhost:${PORT}`;
const YTDLP            = process.env.YTDLP                      || "yt-dlp";
const CACHE_DIR        = process.env.CACHE_DIR                  || "./cache";
const DATA             = process.env.DATA_FILE                  || "./data.json";
const CACHE_TTL        = (parseInt(process.env.CACHE_TTL_HOURS) || 5) * 3_600_000;
const SAVE_DEBOUNCE_MS = 5_000;
const PRUNE_INTERVAL   = 3_600_000;
const MAX_LOGS         = 500;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Range",
  "Vary": "Origin",
};

// ─── FS ───────────────────────────────────────────────────────────────────────
const exists = (p) => access(p, constants.F_OK).then(() => true, () => false);
await mkdir(CACHE_DIR, { recursive: true });

// ─── Init cookies ─────────────────────────────────────────────────────────────
await initCookies();

// ─── DB ───────────────────────────────────────────────────────────────────────
const fresh = () => ({
  meta:   { started: Date.now(), total: 0, errors: 0 },
  logs:   [], hourly: Array(24).fill(0), cache: {}, jobs: {},
});

async function loadDB() {
  try {
    if (await exists(DATA)) {
      const d = JSON.parse(await Bun.file(DATA).text());
      return { ...fresh(), ...d, cache: d.cache ?? {}, jobs: d.jobs ?? {} };
    }
  } catch (e) { console.warn("[db] load failed:", e.message); }
  return fresh();
}

let DB = await loadDB();

let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try { await Bun.write(DATA, JSON.stringify(DB)); }
    catch (e) { console.error("[db] save error:", e.message); }
  }, SAVE_DEBOUNCE_MS);
}

async function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await Bun.write(DATA, JSON.stringify(DB));
}

setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const id in DB.cache) if (now > DB.cache[id].expires) { delete DB.cache[id]; n++; }
  if (n) { console.log(`[cache] pruned ${n}`); scheduleSave(); }
}, PRUNE_INTERVAL);

// ─── Cache ────────────────────────────────────────────────────────────────────
function cacheGet(id) {
  const e = DB.cache[id];
  if (!e) return null;
  if (Date.now() > e.expires) { delete DB.cache[id]; return null; }
  return e.data;
}
function cacheSet(id, data) {
  DB.cache[id] = { iso: new Date().toISOString(), expires: Date.now() + CACHE_TTL, data };
}

// ─── Dedup ────────────────────────────────────────────────────────────────────
const _inflight = new Map();
function dedupe(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ─── Logging ──────────────────────────────────────────────────────────────────
function logReq({ video_id, title, status, duration_ms, url, cached = false }) {
  DB.hourly[new Date().getHours()]++;
  DB.meta.total++;
  if (status === "error") DB.meta.errors++;
  DB.logs.unshift({ iso: new Date().toISOString(), video_id, title, status, duration_ms, url, cached });
  if (DB.logs.length > MAX_LOGS) DB.logs.length = MAX_LOGS;
  scheduleSave();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function videoId(q) {
  if (!q) return null;
  q = q.trim();
  if (!q.includes("/") && !q.includes(".")) return q;
  try {
    const u = new URL(q);
    return u.searchParams.get("v") || u.pathname.split("/").filter(Boolean).pop() || q;
  } catch { return q; }
}

function toYtUrl(q) {
  q = q.trim();
  return (!q.includes("/") && !q.includes(".")) ? `https://www.youtube.com/watch?v=${q}` : q;
}

function p(req, k)              { return new URL(req.url).searchParams.get(k); }
function json(d, s = 200, h={}) { return Response.json(d, { status: s, headers: { ...CORS, ...h } }); }
function err(msg, s = 400)      { return json({ error: msg }, s); }
function noMethod()             { return err("method not allowed", 405); }



// ─── yt-dlp subprocess ────────────────────────────────────────────────────────
export async function runYtDlp(...args) {
  // auto-inject active cookie if not already specified
  const hasCookies = args.includes("--cookies");
  const cookieArgs = !hasCookies ? (() => {
    const p = getActivePath();
    return p ? ["--cookies", p] : [];
  })() : [];

  const proc = Bun.spawn([YTDLP, "--no-warnings", "--no-playlist", ...cookieArgs, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const msg = errText.trim() || `yt-dlp exit ${code}`;
    // detect cookie-related errors → rotate
    if (msg.includes("Sign in") || msg.includes("bot") || msg.includes("429")) {
      const activePath = getActivePath();
      if (activePath) {
        const cookieName = activePath.split("/").pop();
        console.warn(`[cookies] rotating due to: ${msg.slice(0,60)}`);
        rotateOnError(cookieName);
      }
    }
    throw new Error(msg);
  }
  return out.trim();
}

async function getAudioInfo(ytUrl) {
  const raw  = await runYtDlp("-f", "bestaudio", "--dump-json", ytUrl);
  const info = JSON.parse(raw);
  const allAudio = (info.formats || [])
    .filter(f => f.vcodec === "none" && f.acodec !== "none")
    .map(f => ({ itag: f.format_id, mime_type: `audio/${f.ext}`, abr: f.abr ?? null, url: f.url ?? null }));
  return {
    id:                info.id,
    title:             info.title,
    uploader:          info.uploader || info.channel || null,
    duration:          info.duration,
    view_count:        info.view_count,
    thumbnail:         info.thumbnail,
    ext:               info.ext,
    filesize:          info.filesize || info.filesize_approx || null,
    audio_url:         info.url,
    itag:              info.format_id,
    abr:               info.abr ?? null,
    mime_type:         `audio/${info.ext}`,
    all_audio_streams: allAudio,
  };
}

async function getAudioUrl(ytUrl) {
  return runYtDlp("-f", "bestaudio", "--get-url", ytUrl);
}

async function downloadAudio(ytUrl, outPath) {
  await runYtDlp("-f", "bestaudio", "-o", outPath, ytUrl);
}

// ─── Static pages ─────────────────────────────────────────────────────────────
const PAGES = {
  "/":                   ["./src/index.html",         "text/html; charset=utf-8"],
  "/status":             ["./src/status.html",        "text/html; charset=utf-8"],
  "/progress":           ["./src/progress.html",      "text/html; charset=utf-8"],
  "/cookies":            ["./src/cookies.html",       "text/html; charset=utf-8"],
  "/static/all.css":     ["./src/static/all.css",     "text/css"],
  "/static/status.js":   ["./src/static/status.js",   "text/javascript"],
  "/static/progress.js": ["./src/static/progress.js", "text/javascript"],
};

async function serveFile(path, ct) {
  if (!await exists(path)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(path), { headers: { "Content-Type": ct, ...CORS } });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
async function handleAudio(req) {
  const q = p(req, "q"); if (!q) return err("missing ?q=");
  const url = toYtUrl(q), id = videoId(q), t0 = Date.now();

  const hit = cacheGet(id);
  if (hit) {
    logReq({ video_id: id, title: hit.title, status: "ok", duration_ms: Date.now() - t0, url, cached: true });
    return json({ ...hit, cached: true, cache_expires: DB.cache[id]?.expires });
  }

  let result;
  try {
    result = await dedupe(`audio:${id}`, async () => {
      const info = await getAudioInfo(url);
      const vid  = info.id || id;
      const r = {
        id: vid, title: info.title, uploader: info.uploader,
        duration: info.duration, view_count: info.view_count,
        thumbnail: info.thumbnail, ext: info.ext,
        filesize: info.filesize || null, itag: info.itag,
        abr: info.abr, mime_type: info.mime_type,
        audio_url: info.audio_url, all_audio_streams: info.all_audio_streams,
        proxy_url: `${BASE_URL}/proxy?q=${encodeURIComponent(url)}`,
        host_url:  `${BASE_URL}/host?q=${encodeURIComponent(url)}`,
      };
      cacheSet(vid, r);
      return r;
    });
  } catch (e) {
    logReq({ video_id: id, title: null, status: "error", duration_ms: Date.now() - t0, url });
    return err(`yt-dlp failed: ${e.message}`, 500);
  }

  logReq({ video_id: result.id, title: result.title, status: "ok", duration_ms: Date.now() - t0, url });
  return json({ ...result, cached: false, cache_expires: DB.cache[result.id]?.expires });
}

async function handleProxy(req) {
  const q = p(req, "q"); if (!q) return new Response("missing ?q=", { status: 400 });
  const url = toYtUrl(q), id = videoId(q);

  let cdnUrl = cacheGet(id)?.audio_url;
  if (!cdnUrl) {
    try { cdnUrl = await dedupe(`proxy:${id}`, () => getAudioUrl(url)); }
    catch (e) { return new Response(`extraction failed: ${e.message}`, { status: 500 }); }
  }

  const upH = new Headers({
    "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
    "Referer":    "https://www.youtube.com/",
  });
  const range = req.headers.get("range");
  if (range) upH.set("Range", range);

  let up;
  try { up = await fetch(cdnUrl, { headers: upH }); }
  catch (e) { return new Response(`upstream failed: ${e.message}`, { status: 502 }); }

  const rh = new Headers(CORS);
  rh.set("Content-Type",  up.headers.get("content-type")  || "audio/webm");
  rh.set("Accept-Ranges", up.headers.get("accept-ranges") || "bytes");
  for (const h of ["content-length", "content-range", "cache-control", "etag", "last-modified"]) {
    const v = up.headers.get(h); if (v) rh.set(h, v);
  }
  return new Response(up.body, { status: up.status, headers: rh });
}

async function handleHost(req) {
  const q = p(req, "q"); if (!q) return err("missing ?q=");
  const url  = toYtUrl(q);
  const id   = videoId(q) || crypto.randomUUID();
  const file = join(CACHE_DIR, `${id}.webm`);

  if (await exists(file))
    return json({ status: "ready", job_id: id, file_url: `${BASE_URL}/file?id=${id}` });

  if (DB.jobs[id]?.status === "processing")
    return json({ status: "processing", job_id: id, status_url: `${BASE_URL}/job-status?id=${id}`, file_url: null });

  DB.jobs[id] = { status: "processing", started: Date.now(), url, title: null, file, error: null };
  scheduleSave();

  (async () => {
    try {
      let title = id;
      const hit = cacheGet(id);
      if (hit?.title) {
        title = hit.title;
      } else {
        try {
          const info = await getAudioInfo(url);
          title = info.title || id;
          const vid = info.id || id;
          cacheSet(vid, {
            id: vid, title: info.title, uploader: info.uploader,
            duration: info.duration, view_count: info.view_count,
            thumbnail: info.thumbnail, ext: info.ext,
            filesize: info.filesize || null, itag: info.itag,
            abr: info.abr, mime_type: info.mime_type,
            audio_url: info.audio_url, all_audio_streams: info.all_audio_streams,
            proxy_url: `${BASE_URL}/proxy?q=${encodeURIComponent(url)}`,
            host_url:  `${BASE_URL}/host?q=${encodeURIComponent(url)}`,
          });
        } catch {}
      }
      DB.jobs[id].title = title;
      scheduleSave();
      await downloadAudio(url, file);
      Object.assign(DB.jobs[id], { status: "ready", ended: Date.now() });
      scheduleSave();
    } catch (e) {
      Object.assign(DB.jobs[id], { status: "error", error: e.message, ended: Date.now() });
      scheduleSave();
    }
  })();

  return json({ status: "processing", job_id: id, status_url: `${BASE_URL}/job-status?id=${id}`, file_url: null }, 202);
}

async function handleJobStatus(req) {
  const id   = p(req, "id"); if (!id) return err("missing ?id=");
  const file = join(CACHE_DIR, `${id}.webm`);
  if (await exists(file) && DB.jobs[id]?.status !== "processing")
    return json({ status: "ready", job_id: id, file_url: `${BASE_URL}/file?id=${id}` });
  const job = DB.jobs[id];
  if (!job) return err("job not found", 404);
  return json({
    status: job.status, job_id: id, title: job.title,
    error: job.error || null, elapsed: Date.now() - job.started,
    file_url: job.status === "ready" ? `${BASE_URL}/file?id=${id}` : null,
  });
}

async function handleFile(req) {
  const id   = p(req, "id"); if (!id) return new Response("missing ?id=", { status: 400 });
  const file = join(CACHE_DIR, `${id}.webm`);
  if (!await exists(file)) return new Response("file not found", { status: 404 });
  return new Response(Bun.file(file), {
    headers: { "Content-Type": "audio/webm", "Content-Disposition": `attachment; filename="${id}.webm"`, "Accept-Ranges": "bytes", ...CORS },
  });
}

function handleStats() {
  const t = DB.meta.total;
  return json({
    uptime_seconds: Math.floor((Date.now() - DB.meta.started) / 1000),
    total_requests: t, total_errors: DB.meta.errors,
    success_rate:   t > 0 ? Math.round(((t - DB.meta.errors) / t) * 100) : 100,
    cache_entries:  Object.keys(DB.cache).length,
    active_jobs:    Object.values(DB.jobs).filter(j => j.status === "processing").length,
    inflight: _inflight.size, hourly: DB.hourly, logs: DB.logs,
  });
}

async function handleJobsList() {
  const rows = await Promise.all(
    Object.entries(DB.jobs).reverse().map(async ([id, j]) => ({
      id, status: j.status, title: j.title, url: j.url,
      started: j.started, ended: j.ended || null,
      elapsed: (j.ended || Date.now()) - j.started,
      error: j.error || null,
      file_url: j.status === "ready" ? `${BASE_URL}/file?id=${id}` : null,
      has_file: await exists(join(CACHE_DIR, `${id}.webm`)),
    }))
  );
  return json(rows);
}

async function handleDeleteJob(id) {
  const file = join(CACHE_DIR, `${id}.webm`);
  if (await exists(file)) await unlink(file).catch(() => {});
  delete DB.jobs[id];
  scheduleSave();
  return json({ ok: true });
}

function handleCacheInfo() {
  const now = Date.now();
  return json({
    count: Object.keys(DB.cache).length,
    ttl_hours: CACHE_TTL / 3_600_000,
    entries: Object.entries(DB.cache).map(([id, e]) => ({
      id, title: e.data?.title || null, cached_at: e.iso,
      expires: new Date(e.expires).toISOString(),
      ttl_remaining_min: Math.round(Math.max(0, e.expires - now) / 60_000),
    })),
  });
}

// ─── Cookie API handlers ──────────────────────────────────────────────────────
async function handleCookiesList() {
  return json(listCookies());
}

async function handleCookiesUpload(req) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file) return err("no file");
    const text = await file.text();
    if (!text.includes("Netscape HTTP Cookie File") && !text.trim().startsWith("#"))
      return err("invalid format — must be Netscape cookie file");
    const saved = await saveCookie(Buffer.from(text), file.name);
    return json({ ok: true, saved });
  } catch(e) {
    return err(e.message, 500);
  }
}

async function handleCookieDelete(name) {
  try {
    await deleteCookie(name);
    return json({ ok: true });
  } catch(e) {
    return err(e.message, 404);
  }
}

async function handleCookieTest(name, req) {
  const vid = new URL(req.url).searchParams.get("v") || "jNQXAC9IVRw";
  const result = await testCookie(name, vid, runYtDlp);
  return json(result);
}

async function handleCookieTestAll(req) {
  const vid = new URL(req.url).searchParams.get("v") || "jNQXAC9IVRw";
  const results = await testAll(vid, runYtDlp);
  return json({ results });
}

async function handleCookieTestRun(req) {
  const sp     = new URL(req.url).searchParams;
  const vid    = videoId(sp.get("v") || "jNQXAC9IVRw");
  const cookie = sp.get("cookie") || null;
  const result = await testRun(vid, cookie, runYtDlp);
  return json(result);
}

// ─── Router ───────────────────────────────────────────────────────────────────
Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const m = req.method;

    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (PAGES[pathname]) return serveFile(...PAGES[pathname]);

      if (pathname === "/audio")      return handleAudio(req);
      if (pathname === "/proxy")      return handleProxy(req);
      if (pathname === "/host")       return handleHost(req);
      if (pathname === "/job-status") return handleJobStatus(req);
      if (pathname === "/file")       return handleFile(req);
      if (pathname === "/stats")      return handleStats();

      if (pathname === "/export")
        return new Response(JSON.stringify(DB), {
          headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="data.json"', ...CORS },
        });

      // ── cookie routes ──
      if (pathname === "/api/cookies") {
        if (m === "GET")  return handleCookiesList();
        if (m === "POST") return handleCookiesUpload(req);
        return noMethod();
      }
      if (pathname === "/api/cookies/test-all" && m === "POST")
        return handleCookieTestAll(req);
      if (pathname === "/api/cookies/test-run")
        return handleCookieTestRun(req);
      if (pathname.startsWith("/api/cookies/")) {
        const name = decodeURIComponent(pathname.slice("/api/cookies/".length));
        if (m === "DELETE") return handleCookieDelete(name);
        if (m === "GET" && pathname.includes("/test")) {
          const n = name.replace("/test","");
          return handleCookieTest(n, req);
        }
        if (name.endsWith("/test"))
          return handleCookieTest(name.slice(0,-5), req);
        return noMethod();
      }

      // ── jobs / cache routes ──
      if (pathname === "/api/jobs") {
        if (m === "GET") return handleJobsList();
        return noMethod();
      }
      if (pathname.startsWith("/api/jobs/") && m === "DELETE")
        return handleDeleteJob(pathname.slice("/api/jobs/".length));

      if (pathname === "/api/cache") {
        if (m === "GET")    return handleCacheInfo();
        if (m === "DELETE") { DB.cache = {}; scheduleSave(); return json({ ok: true, cleared: "all" }); }
        return noMethod();
      }
      if (pathname.startsWith("/api/cache/") && m === "DELETE") {
        delete DB.cache[pathname.slice("/api/cache/".length)];
        scheduleSave();
        return json({ ok: true });
      }

      // ── update ──
      if (pathname === "/api/update-ytdlp" && m === "POST") {
        try {
          const proc = Bun.spawn(
            ["pip", "install", "--upgrade", "yt-dlp[default]", "--break-system-packages"],
            { stdout: "pipe", stderr: "pipe" }
          );
          const [out, errText] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return json({ ok: true, output: (out + errText).trim() });
        } catch(e) {
          return json({ ok: false, error: e.message }, 500);
        }
      }

      return new Response("not found", { status: 404 });

    } catch (e) {
      console.error(`[${m} ${pathname}]`, e);
      return err(`internal error: ${e.message}`, 500);
    }
  },
});


// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = async (sig) => { console.log(`\n[${sig}] flushing…`); await flushSave(); process.exit(0); };
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`🎵  yt-dlp API  →  ${BASE_URL}`);
console.log(`    TTL: ${CACHE_TTL / 3_600_000}h | debounce: ${SAVE_DEBOUNCE_MS}ms`);
