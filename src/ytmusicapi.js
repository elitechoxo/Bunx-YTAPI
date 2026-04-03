// ─── YouTube Music API ────────────────────────────────────────────────────────
// Simple, reliable wrapper for ytmusicapi (Python)
// Uses direct subprocess calls with temp script files

import { spawn } from "bun";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────────
const YTMUSIC_PY = process.env.YTMUSIC_PY   || "python3";
const AUTH_FILE  = process.env.YTMUSIC_AUTH  || "./browser.json";
const CACHE_TTL  = 30_000;  // 30s cache

// ─── CORS ─────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};

// ─── Simple Cache ──────────────────────────────────────────────────────────────
const reqCache = new Map();

function cacheGet(key) {
  const e = reqCache.get(key);
  if (e && Date.now() < e.expires) return e.data;
  return null;
}

function cacheSet(key, data) {
  reqCache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

// ─── Python Call ───────────────────────────────────────────────────────────────
async function pyCall(cmd, params = {}) {
  const cacheKey = `${cmd}:${JSON.stringify(params)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Build params string safely
  const paramsStr = Object.keys(params).length > 0
    ? JSON.stringify(params).replace(/'/g, "\\'")
    : '';

  const script = `
import json, sys, os
from ytmusicapi import YTMusic

auth = '${AUTH_FILE}'
if auth and os.path.exists(auth):
    yt = YTMusic(auth)
else:
    yt = YTMusic()

try:
    fn = getattr(yt, '${cmd}', None)
    args = ${paramsStr ? `json.loads('${paramsStr}')` : '{}'}
    result = fn(**args) if args else fn()
    print(json.dumps({"ok": True, "result": result}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;

  const scriptPath = `${tmpdir()}/ytmusic_${Date.now()}_${Math.random().toString(36).slice(2)}.py`;

  try {
    await writeFile(scriptPath, script);

    const proc = spawn({
      cmd: [YTMUSIC_PY, scriptPath],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (stderr.trim()) {
      console.error(`[ytmusic] ${cmd} stderr:`, stderr.slice(0, 200));
    }

    const resp = JSON.parse(stdout.trim());
    if (!resp.ok) throw new Error(resp.error);

    cacheSet(cacheKey, resp.result);
    return resp.result;
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

// ─── API Functions (Public) ────────────────────────────────────────────────────
export async function ytmSearch(query, filter = "songs") {
  return pyCall("search", { query, filter });
}

export async function ytmGetSuggestions(query) {
  return pyCall("get_search_suggestions", { query });
}

export async function ytmGetArtist(channelId) {
  return pyCall("get_artist", { channelId });
}

export async function ytmGetArtistAlbums(channelId, params = {}) {
  return pyCall("get_artist_albums", { channelId, params });
}

export async function ytmGetAlbum(browseId) {
  return pyCall("get_album", { browseId });
}

export async function ytmGetSong(videoId) {
  return pyCall("get_song", { videoId });
}

export async function ytmGetLyrics(browseId) {
  return pyCall("get_lyrics", { browseId });
}

export async function ytmGetWatchPlaylist(videoId) {
  return pyCall("get_watch_playlist", { videoId });
}

export async function ytmGetMoodCategories() {
  return pyCall("get_mood_categories", {});
}

export async function ytmGetMoodPlaylists(params) {
  return pyCall("get_mood_playlists", { params });
}

export async function ytmGetCharts(country = "ZZ") {
  return pyCall("get_charts", { country });
}

export async function ytmGetExplore() {
  return pyCall("get_explore", {});
}

export async function ytmGetPlaylist(playlistId) {
  return pyCall("get_playlist", { playlistId });
}

// ─── API Functions (Auth) ──────────────────────────────────────────────────────
export async function ytmGetHome() {
  return pyCall("get_home", {});
}

export async function ytmGetLibraryPlaylists(params = {}) {
  return pyCall("get_library_playlists", { params });
}

export async function ytmGetLibrarySongs(params = {}) {
  return pyCall("get_library_songs", { params });
}

export async function ytmGetLibraryAlbums(params = {}) {
  return pyCall("get_library_albums", { params });
}

export async function ytmGetLibraryArtists(params = {}) {
  return pyCall("get_library_artists", { params });
}

export async function ytmCreatePlaylist(title, description = "", privacy = "PRIVATE", videoIds = [], sourcePlaylist = "") {
  return pyCall("create_playlist", { title, description, privacy_status: privacy, video_ids: videoIds, source_playlist });
}

export async function ytmRateSong(videoId, rating = "LIKE") {
  return pyCall("rate_song", { videoId, rating });
}

export async function ytmAddToPlaylist(playlistId, videoId) {
  return pyCall("add_playlist_items", { playlistId, videoIds: [videoId] });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function json(d, s = 200, h = {}) {
  return Response.json(d, { status: s, headers: { ...CORS, ...h } });
}

function err(msg, s = 400) {
  return json({ error: msg }, s);
}

function p(req, k) {
  return new URL(req.url).searchParams.get(k);
}

// ─── HTTP Handlers ────────────────────────────────────────────────────────────
export function ytmHandleSearch(req) {
  const query = p(req, "q");
  const filter = p(req, "filter") || "songs";
  if (!query) return err("missing ?q=");
  return ytmSearch(query, filter)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleSuggestions(req) {
  const query = p(req, "q");
  if (!query) return err("missing ?q=");
  return ytmGetSuggestions(query)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleArtist(req) {
  const channelId = p(req, "channelId");
  if (!channelId) return err("missing ?channelId=");
  return ytmGetArtist(channelId)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleAlbum(req) {
  const browseId = p(req, "browseId");
  if (!browseId) return err("missing ?browseId=");
  return ytmGetAlbum(browseId)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleSong(req) {
  const videoId = p(req, "videoId");
  if (!videoId) return err("missing ?videoId=");
  return ytmGetSong(videoId)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleWatch(req) {
  const videoId = p(req, "videoId");
  if (!videoId) return err("missing ?videoId=");
  return ytmGetWatchPlaylist(videoId)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleLyrics(req) {
  const browseId = p(req, "browseId");
  if (!browseId) return err("missing ?browseId=");
  return ytmGetLyrics(browseId)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleCharts(req) {
  const country = p(req, "country") || "ZZ";
  return ytmGetCharts(country)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleExplore(req) {
  return ytmGetExplore()
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleMoods(req) {
  return ytmGetMoodCategories()
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleMoodPlaylists(req) {
  const params = p(req, "params");
  if (!params) return err("missing ?params=");
  return ytmGetMoodPlaylists(params)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandlePlaylist(req) {
  const playlistId = p(req, "playlistId");
  if (!playlistId) return err("missing ?playlistId=");
  return ytmGetPlaylist(playlistId)
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleHome(req) {
  return ytmGetHome()
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export function ytmHandleLibrary(req) {
  const type = p(req, "type") || "playlists";
  const handlers = {
    playlists: ytmGetLibraryPlaylists,
    songs: ytmGetLibrarySongs,
    albums: ytmGetLibraryAlbums,
    artists: ytmGetLibraryArtists,
  };
  const fn = handlers[type];
  if (!fn) return err("invalid type, use: playlists|songs|albums|artists");
  return fn()
    .then(result => json({ result }))
    .catch(e => err(e.message, 500));
}

export async function initYTMusic() {
  console.log("[ytmusic] Ready (simple mode)");
}

console.log("[ytmusic] ✅ Loaded");
