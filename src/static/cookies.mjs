import { join }                        from "path";
import { readdir, writeFile, unlink,
         mkdir, stat, access }          from "fs/promises";
import { constants }                    from "fs";
import { randomBytes }                  from "crypto";

const COOKIES_DIR = process.env.COOKIES_DIR || "./cookies";

const exists = (p) => access(p, constants.F_OK).then(() => true, () => false);

await mkdir(COOKIES_DIR, { recursive: true });

// ── state ─────────────────────────────────────────────────────────────────────
// { [filename]: { name, path, status: 'ok'|'dead'|'unknown', added, size, lastTest, lastError } }
let _meta = {};
let _activeFile = null; // currently active cookie file path

// ── load meta from disk on startup ───────────────────────────────────────────
export async function initCookies() {
  const files = (await readdir(COOKIES_DIR)).filter(f => f.endsWith('.txt'));
  for (const f of files) {
    if (!_meta[f]) {
      const s = await stat(join(COOKIES_DIR, f)).catch(() => null);
      _meta[f] = {
        name:     f,
        path:     join(COOKIES_DIR, f),
        status:   'unknown',
        added:    s ? new Date(s.birthtimeMs).toISOString().slice(0,10) : '?',
        size:     s?.size ?? 0,
        lastTest: null,
        lastError: null,
      };
    }
  }
  // remove meta for deleted files
  for (const f of Object.keys(_meta)) {
    if (!files.includes(f)) delete _meta[f];
  }
  // pick active
  if (!_activeFile || !files.includes(_activeFile)) {
    _activeFile = pickActive();
  }
  return list();
}

function pickActive() {
  // prefer ok, fallback to unknown, skip dead
  const ok      = Object.keys(_meta).filter(f => _meta[f].status === 'ok');
  const unknown = Object.keys(_meta).filter(f => _meta[f].status === 'unknown');
  return ok[0] ?? unknown[0] ?? null;
}

// ── public API ────────────────────────────────────────────────────────────────
export function list() {
  return Object.values(_meta).map(m => ({
    name:     m.name,
    status:   m.status,
    added:    m.added,
    size:     m.size,
    lastTest: m.lastTest,
    active:   m.name === _activeFile,
  }));
}

export function getActivePath() {
  if (!_activeFile) return null;
  return _meta[_activeFile]?.path ?? null;
}

// rotate to next alive cookie after a failure
export function rotateOnError(failedFile) {
  if (_meta[failedFile]) {
    _meta[failedFile].status = 'dead';
  }
  const next = pickActive();
  if (next && next !== _activeFile) {
    console.log(`[cookies] rotated from ${_activeFile} → ${next}`);
    _activeFile = next;
    return _meta[next].path;
  }
  if (next) {
    _activeFile = next;
    return _meta[next]?.path ?? null;
  }
  _activeFile = null;
  return null;
}

export async function saveCookie(buffer, originalName) {
  // random name, keep original ext
  const rand = randomBytes(6).toString('hex');
  const name = `ck_${rand}.txt`;
  const path = join(COOKIES_DIR, name);
  await writeFile(path, buffer);
  const s = await stat(path);
  _meta[name] = {
    name, path, status: 'unknown',
    added: new Date().toISOString().slice(0,10),
    size: s.size, lastTest: null, lastError: null,
  };
  if (!_activeFile) _activeFile = name;
  return name;
}

export async function deleteCookie(name) {
  const m = _meta[name];
  if (!m) throw new Error('not found');
  await unlink(m.path).catch(() => {});
  delete _meta[name];
  if (_activeFile === name) _activeFile = pickActive();
}

export async function testCookie(name, videoId, runYtDlp) {
  const m = _meta[name];
  if (!m) throw new Error('not found');
  const t0 = Date.now();
  try {
    const url = await runYtDlp(
      "--cookies", m.path,
      "-f", "bestaudio", "--get-url",
      `https://www.youtube.com/watch?v=${videoId}`
    );
    _meta[name].status    = 'ok';
    _meta[name].lastTest  = new Date().toISOString();
    _meta[name].lastError = null;
    // if this was dead, make it active again
    if (!_activeFile) _activeFile = name;
    return { ok: true, ms: Date.now() - t0, url };
  } catch(e) {
    _meta[name].status    = 'dead';
    _meta[name].lastTest  = new Date().toISOString();
    _meta[name].lastError = e.message;
    if (_activeFile === name) rotateOnError(name);
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

export async function testAll(videoId, runYtDlp) {
  const names = Object.keys(_meta);
  const results = [];
  for (const name of names) {
    const r = await testCookie(name, videoId, runYtDlp);
    results.push({ name, ...r });
  }
  return results;
}

export async function testRun(videoId, cookieName, runYtDlp) {
  let cookiePath;
  if (cookieName && _meta[cookieName]) {
    cookiePath = _meta[cookieName].path;
  } else {
    cookiePath = getActivePath();
  }

  const args = ["-f", "bestaudio", "--dump-json",
    `https://www.youtube.com/watch?v=${videoId}`];
  if (cookiePath) args.unshift("--cookies", cookiePath);

  const t0 = Date.now();
  try {
    const raw  = await runYtDlp(...args);
    const info = JSON.parse(raw);
    return { ok: true, ms: Date.now()-t0, title: info.title, url: info.url };
  } catch(e) {
    return { ok: false, ms: Date.now()-t0, error: e.message };
  }
}
