const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8322599942:AAGa4i5WGRvv4SuzeyUVG6tJyAK-b576R2Y";
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "";
const TELEGRAM_BOT_ID = process.env.TELEGRAM_BOT_ID || "";
const KV_REST_API_URL = process.env.KV_REST_API_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "";
const REDIS_URL = process.env.Cordex_REDIS_URL || process.env.REDIS_URL || "redis://default:3VCLJyqEGp4uhpJrdF4KAOOtEWvmlkzT@redis-13225.crce214.us-east-1-3.ec2.cloud.redislabs.com:13225";
const KV_STORE_KEY = process.env.KV_STORE_KEY || "otp-store";
const PASSKEY_STORE_KEY = process.env.PASSKEY_STORE_KEY || `${KV_STORE_KEY}:passkeys`;
const POST_STORE_KEY = process.env.POST_STORE_KEY || `${KV_STORE_KEY}:posts`;
const THEME_CONFIG_STORE_KEY = process.env.THEME_CONFIG_STORE_KEY || `${KV_STORE_KEY}:theme-config`;
const PROFILE_MEDIA_STORE_KEY = process.env.PROFILE_MEDIA_STORE_KEY || `${KV_STORE_KEY}:profile-media`;
const INDEX_FILE = path.join(__dirname, "index.html");
const ADMIN_V2_DIR = path.join(__dirname, "admin-v2");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "otp-store.json");
const DATA_FILE_BAK = path.join(DATA_DIR, "otp-store.json.bak");
const USER_DIR = path.join(DATA_DIR, "user");
const PASSKEY_FILE = path.join(USER_DIR, "passkey.json");
const POST_DIR = path.join(USER_DIR, "post");
const THEME_CONFIG_FILE = path.join(USER_DIR, "thmfig.json");
const PROFILE_MEDIA_FILE = path.join(USER_DIR, "profile-media.json");
const PROFILE_MEDIA_DIR = path.join(USER_DIR, "files");
const PROFILE_AVATAR_DIR = path.join(PROFILE_MEDIA_DIR, "pro");
const PROFILE_COVER_DIR = path.join(PROFILE_MEDIA_DIR, "prosub");
const FILE_MANAGER_ROOT = __dirname;
const FILE_PREVIEW_LIMIT = 64 * 1024;
const SERVER_BOOT_AT = Date.now();
const USERNAME_MIN = 2;
const USERNAME_MAX = 10;
const DISPLAY_NAME_MAX = 32;
const PASSWORD_MIN = 1;
const PASSWORD_MAX = 64;
const TELEGRAM_TARGET_MAX = 32;
const POST_CONTENT_MAX = 2000;
const POST_COMMENT_MAX = 280;
const EMPTY_STORE = {
  reg: {},
  log: {},
  "log-otp": {},
  telegramLinks: {},
  telegramMeta: {
    lastUpdateId: 0
  },
  events: {},
  consoleLogs: []
};
let writeQueue = Promise.resolve();
let redisClientPromise = null;
let passkeyWriteQueue = Promise.resolve();
let postWriteQueue = Promise.resolve();
let themeConfigWriteQueue = Promise.resolve();
let profileMediaWriteQueue = Promise.resolve();
const DEFAULT_THEME_CONFIG = {
  preset: "default",
  neo: {
    accent: "#4f8cff",
    button: "#ffd54f",
    surface: "#f4efe6",
    ink: "#101217",
    toast: "#ff8159",
    admin: "#7c5cff",
    mode: "light",
    dashboardTheme: "v1",
    typography: "grotesk",
    heading: "loud",
    buttonStyle: "primary"
  }
};

const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8"
};

function isSafeStaticTarget(targetPath) {
  const relative = path.relative(__dirname, targetPath);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function tryServeStaticFile(parsedUrl, res) {
  const pathname = decodeURIComponent(parsedUrl.pathname || "/");
  if (!pathname || pathname === "/" || pathname.startsWith("/api/")) {
    return false;
  }
  const normalized = path.normalize(pathname).replace(/^([/\\])+/, "");
  const filePath = path.join(__dirname, normalized);
  if (!isSafeStaticTarget(filePath)) {
    return false;
  }
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = STATIC_MIME_TYPES[ext] || "application/octet-stream";
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function parseAdminRoute(routeValue = "") {
  const rawPath = typeof routeValue === "object" && routeValue
    ? decodeURIComponent(String(routeValue.pathname || "").trim())
    : "";
  const rawSearch = typeof routeValue === "object" && routeValue
    ? decodeURIComponent(String(routeValue.search || "").trim())
    : decodeURIComponent(String(routeValue || "").trim());
  const match = rawPath.match(/^\/admin\/([a-z0-9-]+)\.([a-z0-9_#-]+)$/i)
    || rawSearch.match(/^\?\/admin\/([a-z0-9-]+)\.([a-z0-9_#-]+)$/i);
  if (!match) {
    return null;
  }
  const pageKey = String(match[1] || "").toLowerCase();
  const ownerKey = String(match[2] || "").toLowerCase();
  const pageMap = {
    dash: "dash.html",
    user: "users.html",
    users: "users.html",
    add: "add-user.html",
    profile: "profile.html"
  };
  const fileName = pageMap[pageKey];
  if (!fileName) {
    return null;
  }
  return {
    pageKey,
    ownerKey,
    filePath: path.join(ADMIN_V2_DIR, fileName)
  };
}

function useRemoteStore() {
  return !!((KV_REST_API_URL && KV_REST_API_TOKEN) || REDIS_URL);
}

async function ensureStore() {
  if (useRemoteStore()) {
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(EMPTY_STORE, null, 2), "utf8");
  }
}

async function ensurePasskeyStore() {
  if (useRemoteStore()) {
    return;
  }
  await fs.mkdir(USER_DIR, { recursive: true });
  try {
    await fs.access(PASSKEY_FILE);
  } catch {
    await fs.writeFile(PASSKEY_FILE, "{}", "utf8");
  }
}

async function ensurePostStore() {
  if (useRemoteStore()) {
    return;
  }
  await fs.mkdir(POST_DIR, { recursive: true });
}

async function ensureThemeConfigStore() {
  if (useRemoteStore()) {
    return;
  }
  await fs.mkdir(USER_DIR, { recursive: true });
  try {
    await fs.access(THEME_CONFIG_FILE);
  } catch {
    await fs.writeFile(THEME_CONFIG_FILE, JSON.stringify({ users: {} }, null, 2), "utf8");
  }
}

async function ensureProfileMediaStore() {
  if (useRemoteStore()) {
    return;
  }
  await fs.mkdir(PROFILE_AVATAR_DIR, { recursive: true });
  await fs.mkdir(PROFILE_COVER_DIR, { recursive: true });
  try {
    await fs.access(PROFILE_MEDIA_FILE);
  } catch {
    await fs.writeFile(PROFILE_MEDIA_FILE, JSON.stringify({ users: {} }, null, 2), "utf8");
  }
}

async function kvCommand(command) {
  const response = await fetch(KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    throw new Error(`KV request gagal (${response.status}).`);
  }

  const result = await response.json();
  if (result?.error) {
    throw new Error(result.error);
  }
  return result;
}

async function getRedisClient() {
  if (!REDIS_URL) {
    throw new Error("REDIS_URL belum diatur.");
  }
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const { createClient } = require("redis");
      const client = createClient({ url: REDIS_URL });
      client.on("error", (error) => {
        console.error("Redis client error:", error.message);
      });
      await client.connect();
      return client;
    })();
  }
  return redisClientPromise;
}

async function readPasskeyStore() {
  if (useRemoteStore()) {
    let raw = "";
    if (KV_REST_API_URL && KV_REST_API_TOKEN) {
      const result = await kvCommand(["GET", PASSKEY_STORE_KEY]);
      raw = typeof result?.result === "string" ? result.result : "";
    } else {
      const client = await getRedisClient();
      raw = await client.get(PASSKEY_STORE_KEY) || "";
    }
    if (!String(raw || "").trim()) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Data passkey rusak. Detail: ${error.message}`);
    }
  }

  await ensurePasskeyStore();
  const raw = await fs.readFile(PASSKEY_FILE, "utf8");
  if (!String(raw || "").trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Data passkey rusak. Detail: ${error.message}`);
  }
}

async function writePasskeyStore(store) {
  const task = async () => {
    if (useRemoteStore()) {
      const payload = JSON.stringify(store || {});
      if (KV_REST_API_URL && KV_REST_API_TOKEN) {
        await kvCommand(["SET", PASSKEY_STORE_KEY, payload]);
      } else {
        const client = await getRedisClient();
        await client.set(PASSKEY_STORE_KEY, payload);
      }
      return;
    }

    await ensurePasskeyStore();
    await fs.writeFile(PASSKEY_FILE, JSON.stringify(store, null, 2), "utf8");
  };
  passkeyWriteQueue = passkeyWriteQueue.then(task, task);
  return passkeyWriteQueue;
}

async function readRemoteJsonStore(key, fallback) {
  let raw = "";
  if (KV_REST_API_URL && KV_REST_API_TOKEN) {
    const result = await kvCommand(["GET", key]);
    raw = typeof result?.result === "string" ? result.result : "";
  } else {
    const client = await getRedisClient();
    raw = await client.get(key) || "";
  }
  if (!String(raw || "").trim()) {
    return fallback;
  }
  return JSON.parse(raw);
}

async function writeRemoteJsonStore(key, value) {
  const payload = JSON.stringify(value);
  if (KV_REST_API_URL && KV_REST_API_TOKEN) {
    await kvCommand(["SET", key, payload]);
    return;
  }
  const client = await getRedisClient();
  await client.set(key, payload);
}

async function readPostStore() {
  if (useRemoteStore()) {
    try {
      const posts = await readRemoteJsonStore(POST_STORE_KEY, []);
      return Array.isArray(posts) ? posts : [];
    } catch (error) {
      throw new Error(`Data post rusak. Detail: ${error.message}`);
    }
  }

  await ensurePostStore();
  const files = await fs.readdir(POST_DIR, { withFileTypes: true });
  const posts = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(POST_DIR, entry.name);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        posts.push(parsed);
      }
    } catch (error) {
      throw new Error(`Gagal membaca post ${entry.name}: ${error.message}`);
    }
  }
  return posts;
}

async function writePostEntry(post) {
  const task = async () => {
    const safeId = String(post?.id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeId) {
      throw new Error("ID post tidak valid.");
    }
    if (useRemoteStore()) {
      const posts = await readPostStore();
      const nextPost = normalizePostRecord(post);
      const index = posts.findIndex((item) => String(item?.id || "") === safeId);
      if (index >= 0) {
        posts[index] = nextPost;
      } else {
        posts.push(nextPost);
      }
      await writeRemoteJsonStore(POST_STORE_KEY, posts);
      return;
    }

    await ensurePostStore();
    const filePath = path.join(POST_DIR, `${safeId}.json`);
    await fs.writeFile(filePath, JSON.stringify(post, null, 2), "utf8");
  };
  postWriteQueue = postWriteQueue.then(task, task);
  return postWriteQueue;
}

function cloneThemeConfig(config = DEFAULT_THEME_CONFIG) {
  return JSON.parse(JSON.stringify(config));
}

function isHexColor(value) {
  return /^#[0-9A-Fa-f]{6}$/.test(String(value || "").trim());
}

function normalizeThemeConfigInput(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const neoSource = source.neo && typeof source.neo === "object" ? source.neo : {};
  return {
    preset: String(source.preset || "default").trim().toLowerCase() === "neobrutalism" ? "neobrutalism" : "default",
    neo: {
      accent: isHexColor(neoSource.accent) ? String(neoSource.accent).trim() : DEFAULT_THEME_CONFIG.neo.accent,
      button: isHexColor(neoSource.button) ? String(neoSource.button).trim() : DEFAULT_THEME_CONFIG.neo.button,
      surface: isHexColor(neoSource.surface) ? String(neoSource.surface).trim() : DEFAULT_THEME_CONFIG.neo.surface,
      ink: isHexColor(neoSource.ink) ? String(neoSource.ink).trim() : DEFAULT_THEME_CONFIG.neo.ink,
      toast: isHexColor(neoSource.toast) ? String(neoSource.toast).trim() : DEFAULT_THEME_CONFIG.neo.toast,
      admin: isHexColor(neoSource.admin) ? String(neoSource.admin).trim() : DEFAULT_THEME_CONFIG.neo.admin,
      mode: ["light", "dark"].includes(String(neoSource.mode || "").trim().toLowerCase())
        ? String(neoSource.mode).trim().toLowerCase()
        : DEFAULT_THEME_CONFIG.neo.mode,
      dashboardTheme: ["v1", "v2"].includes(String(neoSource.dashboardTheme || "").trim().toLowerCase())
        ? String(neoSource.dashboardTheme).trim().toLowerCase()
        : DEFAULT_THEME_CONFIG.neo.dashboardTheme,
      typography: ["grotesk", "poster", "clean"].includes(String(neoSource.typography || "").trim().toLowerCase())
        ? String(neoSource.typography).trim().toLowerCase()
        : DEFAULT_THEME_CONFIG.neo.typography,
      heading: ["compact", "loud", "poster"].includes(String(neoSource.heading || "").trim().toLowerCase())
        ? String(neoSource.heading).trim().toLowerCase()
        : DEFAULT_THEME_CONFIG.neo.heading,
      buttonStyle: ["primary", "inverted", "ghost"].includes(String(neoSource.buttonStyle || "").trim().toLowerCase())
        ? String(neoSource.buttonStyle).trim().toLowerCase()
        : DEFAULT_THEME_CONFIG.neo.buttonStyle
    }
  };
}

async function readThemeConfigStore() {
  if (useRemoteStore()) {
    try {
      const parsed = await readRemoteJsonStore(THEME_CONFIG_STORE_KEY, { users: {} });
      return parsed && typeof parsed === "object" ? parsed : { users: {} };
    } catch (error) {
      throw new Error(`Data theme config rusak. Detail: ${error.message}`);
    }
  }

  await ensureThemeConfigStore();
  const raw = await fs.readFile(THEME_CONFIG_FILE, "utf8");
  if (!String(raw || "").trim()) {
    return { users: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { users: {} };
  } catch (error) {
    throw new Error(`Data theme config rusak. Detail: ${error.message}`);
  }
}

async function writeThemeConfigStore(store) {
  const task = async () => {
    if (useRemoteStore()) {
      await writeRemoteJsonStore(THEME_CONFIG_STORE_KEY, store || { users: {} });
      return;
    }

    await ensureThemeConfigStore();
    await fs.writeFile(THEME_CONFIG_FILE, JSON.stringify(store, null, 2), "utf8");
  };
  themeConfigWriteQueue = themeConfigWriteQueue.then(task, task);
  return themeConfigWriteQueue;
}

async function readProfileMediaStore() {
  if (useRemoteStore()) {
    try {
      const parsed = await readRemoteJsonStore(PROFILE_MEDIA_STORE_KEY, { users: {} });
      return parsed && typeof parsed === "object" ? parsed : { users: {} };
    } catch (error) {
      throw new Error(`Data media profil rusak. Detail: ${error.message}`);
    }
  }

  await ensureProfileMediaStore();
  const raw = await fs.readFile(PROFILE_MEDIA_FILE, "utf8");
  if (!String(raw || "").trim()) {
    return { users: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { users: {} };
  } catch (error) {
    throw new Error(`Data media profil rusak. Detail: ${error.message}`);
  }
}

async function writeProfileMediaStore(store) {
  const task = async () => {
    if (useRemoteStore()) {
      await writeRemoteJsonStore(PROFILE_MEDIA_STORE_KEY, store || { users: {} });
      return;
    }

    await ensureProfileMediaStore();
    await fs.writeFile(PROFILE_MEDIA_FILE, JSON.stringify(store, null, 2), "utf8");
  };
  profileMediaWriteQueue = profileMediaWriteQueue.then(task, task);
  return profileMediaWriteQueue;
}

function sanitizeMediaUserKey(user = "") {
  return String(user || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";
}

function getProfileMediaPayload(mediaStore, user) {
  const safeUser = String(user || "").trim();
  const media = mediaStore?.users?.[safeUser];
  return media && typeof media === "object" ? media : {};
}

function readProfileMediaUsersSync() {
  if (useRemoteStore()) {
    return {};
  }
  try {
    const raw = require("fs").readFileSync(PROFILE_MEDIA_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed?.users || {};
  } catch {
    return {};
  }
}

function getUserThemeConfig(themeStore, user) {
  const safeUser = String(user || "").trim();
  if (!safeUser) {
    return cloneThemeConfig();
  }
  return normalizeThemeConfigInput(themeStore?.users?.[safeUser] || DEFAULT_THEME_CONFIG);
}

function normalizeStore(store) {
  return {
    reg: store.reg || {},
    log: store.log || {},
    "log-otp": store["log-otp"] || {},
    telegramLinks: store.telegramLinks || {},
    telegramMeta: {
      lastUpdateId: Number(store.telegramMeta?.lastUpdateId || 0)
    },
    events: store.events || {},
    consoleLogs: Array.isArray(store.consoleLogs) ? store.consoleLogs : []
  };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const rawIp = Array.isArray(forwarded) ? forwarded[0] : (forwarded ? forwarded.split(",")[0] : req.socket.remoteAddress);
  if (!rawIp) {
    return "unknown";
  }

  return String(rawIp).replace("::ffff:", "").trim();
}

function normalizeDeviceToken(token) {
  return String(token || "").trim();
}

function isTrustedDeviceMatch(accountValue, req, deviceToken) {
  const clientIp = getClientIp(req);
  const normalizedToken = normalizeDeviceToken(deviceToken);
  return (
    accountValue?.trusted === "yes" &&
    accountValue?.trusted_ip === clientIp &&
    !!normalizedToken &&
    accountValue?.trusted_token === normalizedToken
  );
}

function formatDateKey(date = new Date()) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
}

function formatTimeKey(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}-${minutes}-${seconds}`;
}

function randomOtp(length = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let otp = "";
  for (let i = 0; i < length; i += 1) {
    otp += chars[Math.floor(Math.random() * chars.length)];
  }
  return otp;
}

function randomDigitCode(length = 5) {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += String(Math.floor(Math.random() * 10));
  }
  return code;
}

function generatePasskeyCodes(total = 3) {
  const codes = new Set();
  while (codes.size < total) {
    codes.add(randomDigitCode(5));
  }
  return [...codes];
}

function validateUsername(user) {
  const value = String(user || "").trim();
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    return `Username harus ${USERNAME_MIN} sampai ${USERNAME_MAX} karakter.`;
  }
  if (!/^[A-Za-z0-9#._-]+$/.test(value)) {
    return "Username hanya boleh huruf, angka, #, titik, underscore, dan strip.";
  }
  return "";
}

function validateDisplayName(name) {
  const value = String(name || "").trim();
  if (!value) {
    return "Nama panggilan tidak boleh kosong.";
  }
  if (value.length > DISPLAY_NAME_MAX) {
    return `Nama panggilan maksimal ${DISPLAY_NAME_MAX} karakter.`;
  }
  return "";
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    return `Password harus ${PASSWORD_MIN} sampai ${PASSWORD_MAX} karakter.`;
  }
  return "";
}

function validateTelegramTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "ID / Username Telegram wajib diisi.";
  }
  if (raw.length > TELEGRAM_TARGET_MAX + 1) {
    return `ID / Username Telegram maksimal ${TELEGRAM_TARGET_MAX} karakter.`;
  }
  if (/^-?\d{5,20}$/.test(raw)) {
    return "";
  }
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(raw)) {
    return "";
  }
  return "Telegram harus berupa ID angka 5-20 digit atau username @user 5-32 karakter.";
}

function createSessionToken() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 18)}`;
}

async function readStore() {
  if (useRemoteStore()) {
    let raw = "";
    if (KV_REST_API_URL && KV_REST_API_TOKEN) {
      const result = await kvCommand(["GET", KV_STORE_KEY]);
      raw = typeof result?.result === "string" ? result.result : "";
    } else {
      const client = await getRedisClient();
      raw = await client.get(KV_STORE_KEY) || "";
    }
    if (!raw.trim()) {
      return normalizeStore(EMPTY_STORE);
    }
    try {
      return normalizeStore(JSON.parse(raw));
    } catch (error) {
      throw new Error(`Data KV rusak atau belum lengkap. Detail: ${error.message}`);
    }
  }

  await ensureStore();
  const raw = await fs.readFile(DATA_FILE, "utf8");

  if (!raw.trim()) {
    throw new Error("Data store kosong. File JSON tidak akan di-reset otomatis demi menjaga data.");
  }

  try {
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Data store rusak atau belum lengkap. Server tidak menimpa file. Detail: ${error.message}`);
  }
}

async function writeStore(store) {
  const task = async () => {
    if (useRemoteStore()) {
      const payload = JSON.stringify(store);
      if (KV_REST_API_URL && KV_REST_API_TOKEN) {
        await kvCommand(["SET", KV_STORE_KEY, payload]);
      } else {
        const client = await getRedisClient();
        await client.set(KV_STORE_KEY, payload);
      }
      return;
    }

    const payload = JSON.stringify(store, null, 2);
    const tmpFile = path.join(
      DATA_DIR,
      `otp-store.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    );

    try {
      const current = await fs.readFile(DATA_FILE, "utf8");
      if (current.trim()) {
        await fs.writeFile(DATA_FILE_BAK, current, "utf8");
      }
    } catch {
      // ignore backup read errors on first write
    }

    await fs.writeFile(tmpFile, payload, "utf8");
    try {
      await fs.rename(tmpFile, DATA_FILE);
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "ENOENT")) {
        await fs.copyFile(tmpFile, DATA_FILE);
        await fs.unlink(tmpFile).catch(() => {});
      } else {
        throw error;
      }
    }
  };

  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function ensureNestedBucket(root, dateKey, timeKey) {
  root[dateKey] ||= {};
  root[dateKey][timeKey] ||= {};
  return root[dateKey][timeKey];
}

function createUniqueUserKey(bucket, user) {
  if (!bucket[user]) {
    return user;
  }

  let index = 2;
  let candidate = `${user}_${index}`;
  while (bucket[candidate]) {
    index += 1;
    candidate = `${user}_${index}`;
  }

  return candidate;
}

function toTimestamp(dateKey = "", timeKey = "00-00-00") {
  const [day = "01", month = "01", year = "00"] = String(dateKey).split("-");
  const [hour = "00", minute = "00", second = "00"] = String(timeKey).split("-");
  const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);
  return new Date(fullYear, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
}

function collectUserEntries(section) {
  const entries = [];

  function walk(node, context = {}) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }

    if (typeof node.user === "string") {
      entries.push({
        dateKey: context.dateKey || "01-01-00",
        timeKey: context.timeKey || "00-00-00",
        username: context.username || node.user,
        value: node
      });
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const nextContext = { ...context };
      if (!nextContext.dateKey) {
        nextContext.dateKey = key;
      } else if (!nextContext.timeKey) {
        nextContext.timeKey = key;
      } else if (!nextContext.username) {
        nextContext.username = key;
      }
      walk(value, nextContext);
    }
  }

  walk(section);
  return entries;
}

function findLatestUserEntry(section, predicate) {
  const entries = collectUserEntries(section).sort(
    (a, b) => toTimestamp(b.dateKey, b.timeKey) - toTimestamp(a.dateKey, a.timeKey)
  );

  for (const entry of entries) {
    if (predicate(entry.value, entry.username, entry.dateKey, entry.timeKey)) {
      return entry;
    }
  }

  return null;
}

function findAllUserEntries(section, predicate) {
  return collectUserEntries(section)
    .sort((a, b) => toTimestamp(b.dateKey, b.timeKey) - toTimestamp(a.dateKey, a.timeKey))
    .filter((entry) => predicate(entry.value, entry.username, entry.dateKey, entry.timeKey));
}

function getUserAccountState(userEntry) {
  if (!userEntry) {
    return { ok: false, reason: "not-found", message: "User tidak ditemukan." };
  }

  const value = userEntry.value;
  const now = Date.now();
  if (value.deleted === "yes") {
    return { ok: false, reason: "deleted", message: "Account telah dihapus." };
  }

  if (value.blocked === "yes") {
    return { ok: false, reason: "blocked", message: "Account anda di suspend." };
  }

  if (value.hold_until && Number(value.hold_until) > now) {
    return {
      ok: false,
      reason: "held",
      message: "Account anda ditahan, sedang dalam proses.",
      holdUntil: Number(value.hold_until)
    };
  }

  return { ok: true };
}

function createEvent(store, user, type, payload = {}) {
  store.events[user] ||= [];
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    createdAt: Date.now(),
    ...payload
  };
  store.events[user].push(event);
  return event;
}

function appendConsoleLog(store, level, message, meta = {}) {
  store.consoleLogs ||= [];
  store.consoleLogs.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    level,
    message,
    ...meta
  });
  if (store.consoleLogs.length > 220) {
    store.consoleLogs = store.consoleLogs.slice(-220);
  }
}

function formatActor(actor) {
  const safeActor = String(actor || "").trim();
  return safeActor ? `[${safeActor}] ` : "";
}

function clearExpiredEvents(store, user) {
  if (!store.events[user]) {
    return false;
  }

  const now = Date.now();
  const beforeCount = store.events[user].length;
  store.events[user] = store.events[user].filter((event) => !event.expiresAt || event.expiresAt > now);
  if (!store.events[user].length) {
    delete store.events[user];
  }
  const afterCount = store.events[user]?.length || 0;
  return beforeCount !== afterCount;
}

function updateUserEntries(store, user, updater) {
  let changed = false;
  for (const entry of findAllUserEntries(store.reg, (value) => value.user === user)) {
    store.reg[entry.dateKey][entry.timeKey][entry.username] = updater(entry.value);
    changed = true;
  }
  return changed;
}

function pruneEmptyNodes(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      pruneEmptyNodes(value);
      if (!Object.keys(value).length) {
        delete node[key];
      }
    }
  }
}

function removeUserEntries(section, user) {
  let removed = 0;
  for (const entry of findAllUserEntries(section, (value) => value.user === user)) {
    if (section?.[entry.dateKey]?.[entry.timeKey]?.[entry.username]) {
      delete section[entry.dateKey][entry.timeKey][entry.username];
      removed += 1;
    }
  }
  pruneEmptyNodes(section);
  return removed;
}

function updateLatestUserEntry(section, user, updater) {
  const entry = findLatestUserEntry(section, (value) => value.user === user);
  if (!entry) {
    return false;
  }
  section[entry.dateKey][entry.timeKey][entry.username] = updater(entry.value, entry);
  return true;
}

function updateAllUserEntries(section, user, updater) {
  let changed = false;
  for (const entry of findAllUserEntries(section, (value) => value.user === user)) {
    section[entry.dateKey][entry.timeKey][entry.username] = updater(entry.value, entry);
    changed = true;
  }
  return changed;
}

function setActiveSessionToken(store, user, token = "") {
  return updateLatestUserEntry(store.reg, user, (value) => ({
    ...value,
    active_session_token: token
  }));
}

function hasValidSession(store, user, sessionToken) {
  const token = String(sessionToken || "").trim();
  if (!user || !token) {
    return false;
  }
  const entry = findLatestUserEntry(
    store.reg,
    (value) => value.user === user && value.status === "success" && value.active_session_token === token
  );
  return !!entry;
}

function getSessionRole(store, user, sessionToken) {
  if (!hasValidSession(store, user, sessionToken)) {
    return "";
  }
  const entry = findLatestUserEntry(store.reg, (value) => value.user === user && value.status === "success");
  return entry?.value?.role || "";
}

function ensureOwnerSession(store, user, sessionToken) {
  const role = getSessionRole(store, user, sessionToken);
  if (!role) {
    return { ok: false, statusCode: 403, message: "Session tidak valid." };
  }
  if (role !== "owner") {
    return { ok: false, statusCode: 403, message: "Akses owner dibutuhkan." };
  }
  return { ok: true, role };
}

function getServerStatusSummary(store) {
  const dashboard = buildDashboardData(store);
  const mode = KV_REST_API_URL && KV_REST_API_TOKEN ? "kv-rest" : (REDIS_URL ? "redis" : "json-file");
  const uptimeSeconds = Math.max(1, Math.floor(process.uptime()));
  return [
    `server: online`,
    `storage: ${mode}`,
    `uptime: ${uptimeSeconds}s`,
    `users total: ${dashboard.totalUsers || 0}`,
    `roles total: ${Object.keys(dashboard.roleCounts || {}).length}`,
    `console logs: ${(store.consoleLogs || []).length}`,
    `boot at: ${new Date(SERVER_BOOT_AT).toLocaleString("id-ID", { hour12: false })}`
  ];
}

function safeResolveManagedPath(inputPath = "") {
  const normalized = String(inputPath || "").replaceAll("\\", "/").trim();
  const resolved = path.resolve(FILE_MANAGER_ROOT, normalized || ".");
  const relative = path.relative(FILE_MANAGER_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path file manager di luar workspace tidak diizinkan.");
  }
  return resolved;
}

async function buildFileManagerPayload(targetPath = "") {
  const resolvedPath = safeResolveManagedPath(targetPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error("Path file manager harus folder.");
  }

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const items = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith(".git"))
    .map(async (entry) => {
      const fullPath = path.join(resolvedPath, entry.name);
      const entryStat = await fs.stat(fullPath);
      const relativePath = path.relative(FILE_MANAGER_ROOT, fullPath).replaceAll("\\", "/");
      return {
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
        path: relativePath,
        size: entry.isDirectory() ? 0 : entryStat.size,
        updatedAt: entryStat.mtimeMs
      };
    }));

  items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "id");
  });

  return {
    cwd: path.relative(FILE_MANAGER_ROOT, resolvedPath).replaceAll("\\", "/") || ".",
    parent: resolvedPath === FILE_MANAGER_ROOT
      ? ""
      : (path.relative(FILE_MANAGER_ROOT, path.dirname(resolvedPath)).replaceAll("\\", "/") || "."),
    items
  };
}

async function readManagedFile(targetPath = "") {
  const resolvedPath = safeResolveManagedPath(targetPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error("Target bukan file.");
  }
  if (stat.size > FILE_PREVIEW_LIMIT) {
    throw new Error("File terlalu besar untuk preview. Maksimal 64KB.");
  }
  const ext = path.extname(resolvedPath).toLowerCase();
  const textLike = new Set([".txt", ".md", ".json", ".js", ".cjs", ".mjs", ".html", ".css", ".yml", ".yaml", ".toml", ".env", ".gitignore"]);
  if (!textLike.has(ext) && stat.size > 24 * 1024) {
    throw new Error("Preview hanya untuk file teks kecil.");
  }
  const content = await fs.readFile(resolvedPath, "utf8");
  return {
    path: path.relative(FILE_MANAGER_ROOT, resolvedPath).replaceAll("\\", "/"),
    name: path.basename(resolvedPath),
    size: stat.size,
    updatedAt: stat.mtimeMs,
    content
  };
}

function getProfilePayload(store, user, mediaStore = { users: {} }) {
  const entry = findLatestUserEntry(store.reg, (value) => value.user === user && value.status === "success");
  if (!entry) {
    return null;
  }

  const value = entry.value;
  const teleRaw = String(value.tele || "").trim();
  const teleUsername = teleRaw.startsWith("@") ? teleRaw : "";
  const media = getProfileMediaPayload(mediaStore, value.user);
  return {
    user: value.user,
    displayName: value.display_name || value.user,
    bio: value.bio || "Belum ada deskripsi user.",
    registeredAt: `${entry.dateKey} ${entry.timeKey.replaceAll("-", ":")}`,
    telegram: teleRaw,
    telegramUsername: teleUsername,
    role: value.role || "visitor",
    previousUsers: Array.isArray(value.previous_users) ? value.previous_users : [],
    pass: value.pass || "",
    avatarUrl: media.avatarUrl || "",
    coverUrl: media.coverUrl || ""
  };
}

function getPublicProfilePayload(store, user, mediaStore = { users: {} }) {
  const entry = findLatestUserEntry(store.reg, (value) => value.user === user && value.status === "success");
  if (!entry) {
    return null;
  }

  const value = entry.value;
  const media = getProfileMediaPayload(mediaStore, value.user);
  return {
    id: `user-${value.user}`,
    type: "user",
    user: value.user,
    displayName: value.display_name || value.user,
    bio: value.bio || "Belum ada deskripsi user.",
    registeredAt: `${entry.dateKey} ${entry.timeKey.replaceAll("-", ":")}`,
    role: value.role || "visitor",
    status: getStatusFromValue(value),
    online: isUserOnline(value),
    avatarUrl: media.avatarUrl || "",
    coverUrl: media.coverUrl || ""
  };
}

function createPostId(user = "") {
  const safeUser = String(user || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";
  return `post_${Date.now()}_${safeUser}_${Math.random().toString(36).slice(2, 8)}`;
}

function createCommentId(user = "") {
  const safeUser = String(user || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";
  return `comment_${Date.now()}_${safeUser}_${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizePostShareCode(code = "") {
  return String(code || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
}

function createPostShareCode(post = {}) {
  const safePost = post && typeof post === "object" ? post : {};
  const existing = sanitizePostShareCode(safePost.shareCode);
  if (existing) {
    return existing;
  }
  const parts = String(safePost.id || "").trim().split("_").filter(Boolean);
  const createdBase = Math.max(0, Number(safePost.createdAt || Date.now())).toString(36).slice(-6);
  const suffix = String(parts[parts.length - 1] || Math.random().toString(36).slice(2, 8))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6) || "post";
  return sanitizePostShareCode(`${createdBase}-${suffix}`) || sanitizePostShareCode(`post-${suffix}`);
}

function normalizePostRecord(post) {
  const safePost = post && typeof post === "object" ? post : {};
  const likes = Array.from(new Set((Array.isArray(safePost.likes) ? safePost.likes : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)));
  const reposts = Array.from(new Set((Array.isArray(safePost.reposts) ? safePost.reposts : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)));
  const comments = (Array.isArray(safePost.comments) ? safePost.comments : [])
    .map((item) => ({
      id: String(item?.id || createCommentId(item?.user || safePost.user || "user")),
      user: String(item?.user || "").trim(),
      content: String(item?.content || "").trim(),
      createdAt: Number(item?.createdAt || 0),
      updatedAt: Number(item?.updatedAt || item?.createdAt || 0),
      replyToCommentId: String(item?.replyToCommentId || "").trim(),
      replyToUser: String(item?.replyToUser || "").trim()
    }))
    .filter((item) => item.user && item.content);
  return {
    ...safePost,
    shareCode: createPostShareCode(safePost),
    likes,
    reposts,
    comments
  };
}

function getPostFilePath(postId = "") {
  const safeId = String(postId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) {
    throw new Error("ID post tidak valid.");
  }
  return path.join(POST_DIR, `${safeId}.json`);
}

async function readPostEntry(postId = "") {
  if (useRemoteStore()) {
    const safeId = String(postId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
    const posts = await readPostStore();
    const post = posts.find((item) => String(item?.id || "") === safeId);
    if (!post) {
      throw new Error("Posting tidak ditemukan.");
    }
    return normalizePostRecord(post);
  }

  await ensurePostStore();
  const filePath = getPostFilePath(postId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizePostRecord(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Posting tidak ditemukan.");
    }
    throw new Error(`Gagal membaca posting. Detail: ${error.message}`);
  }
}

async function findPostByShareCode(user = "", shareCode = "") {
  const safeUser = String(user || "").trim().toLowerCase();
  const safeShareCode = sanitizePostShareCode(shareCode);
  if (!safeUser || !safeShareCode) {
    return null;
  }
  const posts = await readPostStore();
  return posts.find((item) => {
    const post = normalizePostRecord(item);
    return String(post.user || "").trim().toLowerCase() === safeUser
      && createPostShareCode(post) === safeShareCode;
  }) || null;
}

function getPostAuthorSnapshot(store, user) {
  const mediaUsers = readProfileMediaUsersSync();
  let profile = getPublicProfilePayload(store, user, { users: mediaUsers });
  if (!profile) {
    const fallbackEntry = findLatestUserEntry(store.reg, (value) => {
      const previousUsers = Array.isArray(value.previous_users) ? value.previous_users : [];
      return value.status === "success" && previousUsers.includes(user);
    });
    if (fallbackEntry) {
      const media = mediaUsers?.[fallbackEntry.value.user] || {};
      profile = {
        user: fallbackEntry.value.user,
        displayName: fallbackEntry.value.display_name || fallbackEntry.value.user,
        bio: fallbackEntry.value.bio || "Belum ada deskripsi user.",
        role: fallbackEntry.value.role || "visitor",
        avatarUrl: media.avatarUrl || "",
        coverUrl: media.coverUrl || ""
      };
    }
  }
  if (!profile) {
    return null;
  }
  return {
    user: profile.user,
    displayName: profile.displayName || profile.user,
    role: profile.role || "visitor",
    bio: profile.bio || "Belum ada deskripsi user.",
    avatarUrl: profile.avatarUrl || "",
    coverUrl: profile.coverUrl || ""
  };
}

function toPublicPostPayload(store, post, viewer = "") {
  const safePost = normalizePostRecord(post);
  const author = getPostAuthorSnapshot(store, safePost.user) || safePost.author || {
    user: safePost.user || "user",
    displayName: safePost.user || "User",
    role: "visitor",
    bio: "Belum ada deskripsi user."
  };
  const safeViewer = String(viewer || "").trim().toLowerCase();
  const comments = safePost.comments.map((comment) => {
    const commentAuthor = getPostAuthorSnapshot(store, comment.user) || {
      user: comment.user,
      displayName: comment.user,
      role: "visitor",
      bio: "Belum ada deskripsi user."
    };
    const replyToAuthor = comment.replyToUser
      ? getPostAuthorSnapshot(store, comment.replyToUser) || {
          user: comment.replyToUser,
          displayName: comment.replyToUser,
          role: "visitor",
          bio: "Belum ada deskripsi user."
        }
      : null;
    return {
      id: comment.id,
      content: comment.content,
      createdAt: Number(comment.createdAt || 0),
      updatedAt: Number(comment.updatedAt || comment.createdAt || 0),
      author: commentAuthor,
      replyToCommentId: comment.replyToCommentId || "",
      replyToAuthor
    };
  });
  return {
    id: String(safePost.id || ""),
    shareCode: createPostShareCode(safePost),
    type: "post",
    content: String(safePost.content || ""),
    category: String(safePost.category || "POSTINGAN").toUpperCase(),
    createdAt: Number(safePost.createdAt || 0),
    updatedAt: Number(safePost.updatedAt || safePost.createdAt || 0),
    visibility: String(safePost.visibility || "public"),
    author,
    stats: {
      likes: safePost.likes.length,
      reposts: safePost.reposts.length,
      comments: comments.length
    },
    reactions: {
      liked: !!safeViewer && safePost.likes.some((item) => item.toLowerCase() === safeViewer),
      reposted: !!safeViewer && safePost.reposts.some((item) => item.toLowerCase() === safeViewer)
    },
    comments
  };
}

async function getPublicPostFeed(store, limit = 24, viewer = "") {
  const posts = await readPostStore();
  return posts
    .filter((item) => item && typeof item === "object" && String(item.visibility || "public") === "public" && String(item.content || "").trim())
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(Number(limit || 24), 60)))
    .map((item) => toPublicPostPayload(store, item, viewer));
}

async function getPostsByUser(store, user, limit = 24, viewer = "") {
  const safeUser = String(user || "").trim();
  if (!safeUser) {
    return [];
  }
  const posts = await readPostStore();
  return posts
    .filter((item) => item && typeof item === "object" && String(item.content || "").trim())
    .map((item) => toPublicPostPayload(store, item, viewer))
    .filter((item) => {
      const authorUser = String(item.author?.user || "").trim();
      return authorUser === safeUser;
    })
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(Number(limit || 24), 60)));
}

function getViewerFromSession(store, user, sessionToken) {
  const safeUser = String(user || "").trim();
  const safeToken = String(sessionToken || "").trim();
  if (!safeUser || !safeToken) {
    return "";
  }
  return hasValidSession(store, safeUser, safeToken) ? safeUser : "";
}

function getPasskeyPayload(passkeyStore, user) {
  const entry = passkeyStore?.[user];
  const codes = Array.isArray(entry?.codes) ? entry.codes.filter(Boolean) : [];
  return {
    user,
    enabled: codes.length > 0,
    codes,
    total: codes.length,
    updatedAt: Number(entry?.updatedAt || 0)
  };
}

function getStatusFromValue(value) {
  return value.deleted === "yes" ? "deleted" :
    value.blocked === "yes" ? "blocked" :
    value.hold_until && Number(value.hold_until) > Date.now() ? "held" :
    "active";
}

function isUserOnline(value) {
  return !!String(value.active_session_token || "").trim() && getStatusFromValue(value) === "active";
}

function buildSearchData(store, query) {
  const rawQuery = String(query || "").trim();
  const normalized = rawQuery.toLowerCase();
  const onlyUserQuery = normalized.startsWith("user:");
  const userNeedle = onlyUserQuery ? normalized.slice(5).trim() : normalized;

  const articlePool = [
    { id: "article-home", type: "article", title: "Home", slug: "home", body: "Halaman utama untuk visitor dan owner setelah login berhasil." },
    { id: "article-info", type: "article", title: "Info", slug: "info", body: "Bagian informasi umum sistem login, OTP, role, dan status account." },
    { id: "article-contact", type: "article", title: "Contact", slug: "contact", body: "Kontak atau identitas singkat account yang sedang aktif." },
    { id: "article-profile", type: "article", title: "User Profile", slug: "user-profile", body: "Profil user berisi nama panggilan, role, username, telegram, password, dan deskripsi." },
    {
      id: "article-azee",
      type: "article",
      title: "Artikel Account Azee",
      slug: "account-azee",
      body: "Contoh artikel tentang account azee dan peran user tersebut di dalam situs.",
      summary: "Ringkasan singkat tentang siapa azee, role-nya, dan kenapa account ini penting.",
      content: "Account azee dipakai sebagai contoh artikel pencarian. Isi ini menjelaskan bahwa azee adalah user yang dipakai untuk demo profile, role, status online, dan tampilan detail hasil search di halaman utama."
    }
  ];

  const regEntries = collectUserEntries(store.reg)
    .filter((entry) => entry.value.status === "success")
    .sort((a, b) => toTimestamp(b.dateKey, b.timeKey) - toTimestamp(a.dateKey, a.timeKey));

  const latestUserMap = new Map();
  for (const entry of regEntries) {
    if (!latestUserMap.has(entry.value.user)) {
      latestUserMap.set(entry.value.user, entry);
    }
  }
  const mediaUsers = readProfileMediaUsersSync();

  const users = Array.from(latestUserMap.values()).map((entry) => {
    const value = entry.value;
    const media = mediaUsers?.[value.user] || {};
    return {
      id: `user-${value.user}`,
      type: "user",
      user: value.user,
      displayName: value.display_name || value.user,
      role: value.role || "visitor",
      bio: value.bio || "Belum ada deskripsi user.",
      registeredAt: `${entry.dateKey} ${entry.timeKey.replaceAll("-", ":")}`,
      status: getStatusFromValue(value),
      online: isUserOnline(value),
      tele: value.tele || "",
      avatarUrl: media.avatarUrl || "",
      coverUrl: media.coverUrl || ""
    };
  });

  const filteredUsers = !userNeedle
    ? users
    : users.filter((item) => {
      const hay = [
        item.user,
        item.displayName,
        item.role,
        item.bio
      ].join(" ").toLowerCase();
      if (onlyUserQuery) {
        return item.user.toLowerCase().includes(userNeedle);
      }
      return hay.includes(userNeedle);
    });

  const filteredArticles = onlyUserQuery || !normalized
    ? []
    : articlePool.filter((item) => `${item.title} ${item.slug} ${item.body}`.toLowerCase().includes(normalized));

  return {
    query: rawQuery,
    results: [...filteredUsers, ...filteredArticles].slice(0, 18)
  };
}

function listAllRoles(store) {
  return Object.keys(buildDashboardData(store).roles || {}).sort();
}

function runAdminAction(store, { user, action, durationSeconds, role, actor }) {
  const actorLabel = formatActor(actor);
  if (action !== "delete_role") {
    const target = findLatestUserEntry(store.reg, (value) => value.user === user);
    if (!target) {
      return { error: "User target tidak ditemukan." };
    }
  }

  const actionMap = {
    delete() {
      updateUserEntries(store, user, (value) => ({ ...value, deleted: "yes", trusted: "no", trusted_ip: "", trusted_token: "" }));
      createEvent(store, user, "delete", {
        title: "account telah didelete",
        body: "see you",
        expiresAt: Date.now() + 15000,
        countdownSeconds: 5,
        mode: "block"
      });
      appendConsoleLog(store, "warn", `${actorLabel}Soft delete account: ${user}`);
      return { message: "Account berhasil di-delete." };
    },
    undelete() {
      const changed = updateUserEntries(store, user, (value) => ({ ...value, deleted: "no" }));
      if (!changed) {
        return { error: "Account tidak ditemukan untuk undelete." };
      }
      createEvent(store, user, "undelete", {
        title: "Account dipulihkan kembali",
        body: "account aktif lagi",
        expiresAt: Date.now() + 12000
      });
      appendConsoleLog(store, "success", `${actorLabel}Undelete account: ${user}`);
      return { message: "Account berhasil di-undelete." };
    },
    delete_perm() {
      const regRemoved = removeUserEntries(store.reg, user);
      removeUserEntries(store.log, user);
      removeUserEntries(store["log-otp"], user);
      delete store.events[user];
      if (!regRemoved) {
        return { error: "Account tidak ditemukan untuk delete permanen." };
      }
      appendConsoleLog(store, "error", `${actorLabel}Delete permanen account: ${user}`);
      return { message: "Account berhasil dihapus permanen dari database." };
    },
    hold() {
      const seconds = Math.max(1, Number(durationSeconds || 0));
      const holdUntil = Date.now() + (seconds * 1000);
      updateUserEntries(store, user, (value) => ({ ...value, hold_until: holdUntil, blocked: "no" }));
      createEvent(store, user, "hold", {
        title: "account anda ditahan, sedang dalam proses.",
        body: `time:${new Date(holdUntil).toLocaleTimeString("id-ID", { hour12: false })}`,
        expiresAt: holdUntil,
        holdUntil,
        countdownSeconds: seconds,
        mode: "block"
      });
      appendConsoleLog(store, "warn", `${actorLabel}Hold account: ${user} selama ${seconds} detik`);
      return { message: "Account berhasil ditahan.", holdUntil };
    },
    release_hold() {
      updateUserEntries(store, user, (value) => ({ ...value, hold_until: 0 }));
      createEvent(store, user, "hold-release", {
        title: "penahanan dihentikan",
        body: "account aktif kembali",
        expiresAt: Date.now() + 12000
      });
      appendConsoleLog(store, "info", `${actorLabel}Release hold account: ${user}`);
      return { message: "Tahan berhasil dihentikan." };
    },
    block() {
      updateUserEntries(store, user, (value) => ({ ...value, blocked: "yes", trusted: "no", trusted_ip: "", trusted_token: "" }));
      createEvent(store, user, "block", {
        title: "Account anda di suspend",
        body: "akses account sedang diblokir",
        expiresAt: Date.now() + 20000,
        mode: "block"
      });
      appendConsoleLog(store, "warn", `${actorLabel}Block account: ${user}`);
      return { message: "Account berhasil di-block." };
    },
    unblock() {
      updateUserEntries(store, user, (value) => ({ ...value, blocked: "no" }));
      createEvent(store, user, "unblock", {
        title: "Account diaktifkan kembali",
        body: "akses account sudah dibuka",
        expiresAt: Date.now() + 12000
      });
      appendConsoleLog(store, "info", `${actorLabel}Unblock account: ${user}`);
      return { message: "Account berhasil di-unblock." };
    },
    set_role() {
      const targetRole = String(role || "").trim().toLowerCase();
      if (!targetRole) {
        return { error: "Role tujuan wajib diisi." };
      }
      const changed = updateUserEntries(store, user, (value) => ({ ...value, role: targetRole }));
      if (!changed) {
        return { error: "User target tidak ditemukan." };
      }
      createEvent(store, user, "set-role", {
        title: "Role account diperbarui",
        body: `role baru: ${targetRole}`,
        expiresAt: Date.now() + 12000
      });
      appendConsoleLog(store, "info", `${actorLabel}Set role ${user} -> ${targetRole}`);
      return { message: `Role user berhasil dipindahkan ke ${targetRole}.` };
    },
    delete_role() {
      const targetRole = String(role || "").trim().toLowerCase();
      if (!targetRole || targetRole === "visitor" || targetRole === "owner") {
        return { error: "Role bawaan tidak bisa dihapus." };
      }
      let changed = false;
      for (const entry of findAllUserEntries(store.reg, (value) => (value.role || "visitor") === targetRole)) {
        store.reg[entry.dateKey][entry.timeKey][entry.username] = {
          ...entry.value,
          role: "visitor"
        };
        changed = true;
      }
      if (!changed) {
        return { error: "Role tidak ditemukan atau sudah kosong." };
      }
      appendConsoleLog(store, "warn", `${actorLabel}Delete role ${targetRole}, semua user kembali ke visitor`);
      return { message: `Role ${targetRole} berhasil dihapus dan user dipindah ke visitor.` };
    }
  };

  if (!actionMap[action]) {
    return { error: "Action tidak dikenali." };
  }

  return actionMap[action]();
}

function executeConsoleCommand(store, rawCommand, actor) {
  const command = String(rawCommand || "").trim();
  if (!command) {
    return { error: "Command tidak boleh kosong." };
  }

  const actorLabel = formatActor(actor);
  appendConsoleLog(store, "cmd", `${actorLabel}$ ${command}`);
  const parts = command.split(/\s+/);
  const head = parts[0].toLowerCase();
  const sub = (parts[1] || "").toLowerCase();

  const helpMap = {
    help: [
      "",
      "> MENU HELP <",
      "---------------",
      "> help",
      "> help notify",
      "> help delete",
      "> help edit",
      "> help export",
      "> help users",
      "> help roles",
      "> help check",
      "> help set-role",
      "> help hold",
      "> help block"
    ],
    notify: [
      "",
      "> MENU HELP <",
      "---------------",
      "> notify <test|global|role:nama|user:nama> | text | durasi | color | block",
      "> contoh: notify test | hallo | 4 | info",
      "> contoh: notify global | server maintenance | 6 | error | block",
      "> contoh: notify role:owner | hallo owner | 5 | success"
    ],
    delete: [
      "",
      "> MENU HELP <",
      "---------------",
      "> delete <user>",
      "> undelete <user>",
      "> delete-perm <user>",
      "> delete = soft delete",
      "> undelete = pulihkan akun",
      "> delete-perm = hapus permanen dari JSON"
    ],
    edit: [
      "",
      "> MENU HELP <",
      "---------------",
      "> edit user <nama> tele <nilai>",
      "> edit user <nama> pass <nilai>",
      "> edit user <nama> role <nilai>"
    ],
    export: [
      "",
      "> MENU HELP <",
      "---------------",
      "> export log txt",
      "> export log json"
    ],
    users: [
      "",
      "> MENU HELP <",
      "---------------",
      "> users",
      "> menampilkan semua user aktif dan status terakhir",
      "> format: user | role | status | last login"
    ],
    roles: [
      "",
      "> MENU HELP <",
      "---------------",
      "> roles",
      "> menampilkan jumlah user per role",
      "> contoh: visitor: 8"
    ],
    check: [
      "",
      "> MENU HELP <",
      "---------------",
      "> check user <nama>",
      "> menampilkan detail user",
      "> role, tele, status, trusted"
    ],
    "set-role": [
      "",
      "> MENU HELP <",
      "---------------",
      "> set-role <user> <role>",
      "> memindahkan user ke role lain",
      "> contoh: set-role budi owner"
    ],
    hold: [
      "",
      "> MENU HELP <",
      "---------------",
      "> hold <user> <detik>",
      "> release-hold <user>",
      "> contoh: hold budi 120"
    ],
    block: [
      "",
      "> MENU HELP <",
      "---------------",
      "> block <user>",
      "> unblock <user>",
      "> block = suspend account",
      "> unblock = buka suspend"
    ],
    clear: [
      "",
      "> MENU HELP <",
      "---------------",
      "> clear",
      "> membersihkan isi console log"
    ],
    ping: [
      "",
      "> MENU HELP <",
      "---------------",
      "> ping",
      "> cek apakah server owner console aktif",
      "> menampilkan latency ringan dan waktu server"
    ],
    status: [
      "",
      "> MENU HELP <",
      "---------------",
      "> status",
      "> menampilkan status data server",
      "> storage, uptime, total user, dan log"
    ],
    git: [
      "",
      "> MENU HELP <",
      "---------------",
      "> git clone <repo-url> [folder]",
      "> clone repo ke workspace server lokal",
      "> command ini tidak aktif di deploy vercel"
    ]
  };

  const topicAliases = {
    "release-hold": "hold",
    unblock: "block",
    undelete: "delete",
    "delete-perm": "delete",
    "check-user": "check"
  };

  if (head === "help") {
    const requestedTopic = sub || "help";
    const topic = helpMap[requestedTopic] ? requestedTopic : (topicAliases[requestedTopic] || requestedTopic);
    return {
      message: `Menampilkan bantuan ${requestedTopic}.`,
      output: helpMap[topic] || [
        "",
        "> MENU HELP <",
        "---------------",
        "> help",
        "> users",
        "> roles",
        "> check user <nama>",
        "> set-role <user> <role>",
        "> block <user>",
        "> unblock <user>",
        "> delete <user>",
        "> undelete <user>",
        "> delete-perm <user>",
        "> hold <user> <detik>",
        "> release-hold <user>",
        "> edit user <nama> tele|pass|role <nilai>",
        "> notify <test|global|role:nama|user:nama> | text | durasi | color | block",
        "> export log txt",
        "> export log json",
        "> ping",
        "> status",
        "> git clone <repo-url> [folder]",
        "> help users / roles / check / set-role / hold / block"
      ]
    };
  }

  if (head === "clear") {
    store.consoleLogs = [];
    return { message: "Console dibersihkan.", output: ["console cleared"] };
  }

  if (head === "users") {
    const users = buildDashboardData(store).roles;
    const list = Object.values(users).flat().map((item) => `${item.user} | ${item.role} | ${item.status} | last:${item.lastLogin}`);
    return { message: `Total user: ${list.length}`, output: list.length ? list : ["tidak ada user"] };
  }

  if (head === "roles") {
    const data = buildDashboardData(store);
    const list = Object.entries(data.roleCounts || {}).map(([role, total]) => `${role}: ${total}`);
    return { message: "Role berhasil dibaca.", output: list.length ? list : ["tidak ada role"] };
  }

  if (head === "ping") {
    return {
      message: "Ping server berhasil.",
      output: [
        "pong",
        `server time: ${new Date().toLocaleString("id-ID", { hour12: false })}`,
        `uptime: ${Math.max(1, Math.floor(process.uptime()))}s`
      ]
    };
  }

  if (head === "status") {
    return {
      message: "Status data server berhasil dibaca.",
      output: getServerStatusSummary(store)
    };
  }

  if (head === "check" && sub === "user") {
    const username = parts.slice(2).join(" ");
    const entry = findLatestUserEntry(store.reg, (value) => value.user === username && value.status === "success");
    if (!entry) {
      return { error: "User tidak ditemukan." };
    }
    const value = entry.value;
    const status =
      value.deleted === "yes" ? "deleted" :
      value.blocked === "yes" ? "blocked" :
      value.hold_until && Number(value.hold_until) > Date.now() ? "held" :
      "active";
    return {
      message: `Data user ${username} ditemukan.`,
      output: [
        `user: ${value.user}`,
        `display name: ${value.display_name || value.user}`,
        `role: ${value.role || "visitor"}`,
        `tele: ${value.tele || "-"}`,
        `status: ${status}`,
        `trusted: ${value.trusted || "no"}`,
        `previous user: ${(Array.isArray(value.previous_users) && value.previous_users.length) ? value.previous_users.join(", ") : "-"}`
      ]
    };
  }

  if (head === "set-role") {
    const username = parts[1];
    const targetRole = parts.slice(2).join(" ").toLowerCase();
    if (!username || !targetRole) {
      return { error: "Format: set-role <user> <role>" };
    }
    const result = runAdminAction(store, { user: username, action: "set_role", role: targetRole, actor });
    return result.error ? result : { message: result.message, output: [`${username} -> ${targetRole}`] };
  }

  if (["block", "unblock", "delete", "undelete", "delete-perm"].includes(head)) {
    const username = parts[1];
    if (!username) {
      return { error: `Format: ${head} <user>` };
    }
    const result = runAdminAction(store, {
      user: username,
      action: head === "delete-perm" ? "delete_perm" : head,
      actor
    });
    return result.error ? result : { message: result.message, output: [result.message] };
  }

  if (head === "hold") {
    const username = parts[1];
    const durationSeconds = Number(parts[2] || 0);
    if (!username || !durationSeconds) {
      return { error: "Format: hold <user> <detik>" };
    }
    const result = runAdminAction(store, { user: username, action: "hold", durationSeconds, actor });
    return result.error ? result : { message: result.message, output: [`hold ${username} ${durationSeconds}s`] };
  }

  if (head === "release-hold") {
    const username = parts[1];
    if (!username) {
      return { error: "Format: release-hold <user>" };
    }
    const result = runAdminAction(store, { user: username, action: "release_hold", actor });
    return result.error ? result : { message: result.message, output: [result.message] };
  }

  if (head === "edit" && sub === "user") {
    const username = parts[2];
    const field = (parts[3] || "").toLowerCase();
    const value = parts.slice(4).join(" ").trim();
    if (!username || !["tele", "pass", "role"].includes(field) || !value) {
      return { error: "Format: edit user <nama> tele|pass|role <nilai>" };
    }

    const keyMap = { tele: "tele", pass: "pass", role: "role" };
    const normalizedValue = field === "role" ? value.toLowerCase() : value;
    const changed = updateLatestUserEntry(store.reg, username, (entryValue) => ({
      ...entryValue,
      [keyMap[field]]: normalizedValue
    }));

    if (!changed) {
      return { error: "User tidak ditemukan." };
    }

    appendConsoleLog(store, "info", `${actorLabel}Edit user ${username}: ${field} -> ${normalizedValue}`);
    return {
      message: `User ${username} berhasil diupdate.`,
      output: [`${field}: ${normalizedValue}`]
    };
  }

  if (head === "notify") {
    const actorUser = String(actor || "").trim();
    if (!actorUser) {
      return { error: "Notify console butuh actor user yang sedang login." };
    }
    const rawPayload = command.slice(6).trim();
    if (!rawPayload) {
      return { error: "Format: notify <test|global|role:nama|user:nama> | text | durasi | color | block" };
    }
    const partsNotify = rawPayload.split("|").map((part) => part.trim()).filter(Boolean);
    const target = String(partsNotify[0] || "test").toLowerCase();
    const text = partsNotify[1];
    if (!text) {
      return { error: "Format notify butuh target dan text." };
    }
    const durationSeconds = Math.max(1, Number(partsNotify[2] || 4));
    const color = ["info", "success", "error"].includes(String(partsNotify[3] || "").toLowerCase())
      ? String(partsNotify[3]).toLowerCase()
      : "info";
    const mode = String(partsNotify[4] || "").toLowerCase() === "block" ? "block" : "normal";

    let targets = [];
    if (target === "test") {
      targets = [actorUser];
    } else if (target === "global") {
      targets = Object.values(buildDashboardData(store).roles || {}).flat().map((item) => item.user);
    } else if (target.startsWith("role:")) {
      const roleName = target.slice(5).trim();
      targets = (buildDashboardData(store).roles?.[roleName] || []).map((item) => item.user);
    } else if (target.startsWith("user:")) {
      targets = [target.slice(5).trim()];
    } else {
      return { error: "Target notify harus test, global, role:nama, atau user:nama." };
    }

    const uniqueTargets = [...new Set(targets.filter(Boolean))];
    if (!uniqueTargets.length) {
      return { error: "Target notify tidak menemukan user yang cocok." };
    }

    uniqueTargets.forEach((targetUser) => {
      createEvent(store, targetUser, "owner-notify", {
        title: text,
        body: `console notify dari ${actorUser}`,
        expiresAt: Date.now() + (durationSeconds * 1000),
        countdownSeconds: durationSeconds,
        color,
        mode
      });
    });

    appendConsoleLog(store, "success", `${actorLabel}Send notify -> ${target} (${uniqueTargets.length} user): ${text}`);
    return {
      message: "Notify berhasil dikirim.",
      output: [`notify ${target} | ${text} | ${durationSeconds}s | ${color} | ${mode}`]
    };
  }

  if (head === "export" && sub === "log") {
    const format = (parts[2] || "txt").toLowerCase();
    if (!["txt", "json"].includes(format)) {
      return { error: "Format export hanya txt atau json." };
    }
    const logs = (store.consoleLogs || []).slice(-220);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (format === "json") {
      return {
        message: "Log berhasil disiapkan.",
        output: [`export log json (${logs.length} baris)`],
        download: {
          filename: `system-log-${timestamp}.json`,
          mime: "application/json",
          content: JSON.stringify(logs, null, 2)
        }
      };
    }

    const text = logs.map((log) => {
      const time = new Date(log.ts || Date.now()).toLocaleString("id-ID", { hour12: false });
      return `[${time}] [${String(log.level || "info").toUpperCase()}] ${log.message}`;
    }).join("\n");

    return {
      message: "Log berhasil disiapkan.",
      output: [`export log txt (${logs.length} baris)`],
      download: {
        filename: `system-log-${timestamp}.txt`,
        mime: "text/plain;charset=utf-8",
        content: text
      }
    };
  }

  if (head === "git" && sub === "clone") {
    if (process.env.VERCEL) {
      return { error: "git clone tidak didukung di server Vercel. Jalankan command ini di server lokal." };
    }
    const repoUrl = parts[2];
    const targetFolder = parts[3] || "";
    if (!repoUrl) {
      return { error: "Format: git clone <repo-url> [folder]" };
    }
    const args = ["clone", repoUrl];
    if (targetFolder) {
      args.push(targetFolder);
    }
    const result = spawnSync("git", args, {
      cwd: FILE_MANAGER_ROOT,
      encoding: "utf8",
      timeout: 120000
    });
    if (result.error) {
      return { error: `git clone gagal: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return { error: String(result.stderr || result.stdout || "git clone gagal dijalankan.").trim() };
    }
    return {
      message: "Repository berhasil di-clone.",
      output: String(result.stdout || "git clone selesai.")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    };
  }

  return { error: "Command tidak dikenali. Ketik help untuk melihat daftar command." };
}

async function parseBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

async function sendTelegramMessage(chatIdOrUsername, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    return {
      ok: false,
      description: "TELEGRAM_BOT_TOKEN belum diatur."
    };
  }

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatIdOrUsername).trim(),
        text
      }),
      signal: AbortSignal.timeout(10000)
    });

    return response.json();
  } catch (error) {
    return {
      ok: false,
      description: `Telegram request gagal: ${error.message || "unknown error"}`
    };
  }
}

async function callTelegramApi(method, payload = null) {
  if (!TELEGRAM_BOT_TOKEN) {
    return {
      ok: false,
      description: "TELEGRAM_BOT_TOKEN belum diatur."
    };
  }

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const options = payload
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      }
    : {
        method: "GET",
        signal: AbortSignal.timeout(10000)
      };
  try {
    const response = await fetch(apiUrl, options);
    return response.json();
  } catch (error) {
    return {
      ok: false,
      description: `Telegram API ${method} gagal: ${error.message || "unknown error"}`
    };
  }
}

async function getTelegramBotInfo() {
  try {
    const result = await callTelegramApi("getMe");
    if (result?.ok) {
      const username = result.result?.username ? `@${result.result.username}` : (TELEGRAM_BOT_USERNAME || "@bot");
      const id = String(result.result?.id || TELEGRAM_BOT_ID || "-");
      return {
        ok: true,
        username,
        id
      };
    }
  } catch {
    // ignore and use fallback below
  }

  return {
    ok: false,
    username: TELEGRAM_BOT_USERNAME || "@bot",
    id: String(TELEGRAM_BOT_ID || "-")
  };
}

async function getTelegramUpdates(options = {}) {
  const payload = {};
  if (Number.isFinite(options.offset) && Number(options.offset) > 0) {
    payload.offset = Number(options.offset);
  }
  if (Number.isFinite(options.timeout) && Number(options.timeout) >= 0) {
    payload.timeout = Number(options.timeout);
  }
  return Object.keys(payload).length ? callTelegramApi("getUpdates", payload) : callTelegramApi("getUpdates");
}

function normalizeTelegramTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^-?\d+$/.test(raw)) {
    return raw;
  }
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function normalizePublicUrl(rawValue = "") {
  const raw = String(rawValue || "").trim();
  if (!raw || !/^https?:\/\//i.test(raw)) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || "").toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function getPublicWebsiteUrl() {
  return normalizePublicUrl(process.env.WEBSITE_URL || "");
}

function getPublicBaseUrlFromRequest(req) {
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const forwardedHost = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req?.headers?.host || "").trim();
  if (!host) {
    return "";
  }
  return normalizePublicUrl(`${proto}://${host}`);
}

function createWebsiteInlineKeyboard(websiteUrl = "") {
  const safeUrl = normalizePublicUrl(websiteUrl) || getPublicWebsiteUrl();
  if (!safeUrl) {
    return undefined;
  }
  return {
    inline_keyboard: [[
      {
        text: "Link Website",
        url: safeUrl
      }
    ]]
  };
}

function createPasskeyReplyMarkup(user, websiteUrl = "", otp = "") {
  const rows = [];
  const safeOtp = String(otp || "").trim();
  if (safeOtp) {
    rows.push([{
      text: "Copy OTP",
      copy_text: {
        text: safeOtp
      }
    }]);
  }
  const keyboardRow = [{
    text: "Reset",
    callback_data: `passkey_reset:${encodeURIComponent(user)}`
  }];
  const safeUrl = normalizePublicUrl(websiteUrl) || getPublicWebsiteUrl();
  if (safeUrl) {
    keyboardRow.push({
      text: "Link Website",
      url: safeUrl
    });
  }
  rows.push(keyboardRow);
  return {
    inline_keyboard: rows
  };
}

function createPasskeyOtpText(otp = "", extraLine = "") {
  const lines = [
    "[!] <b>PASS KEY</b> [!]",
    `ini adalah kode reset pass key sebagai otp : <tg-spoiler>${escapeTelegramHtml(otp || "-")}</tg-spoiler>`,
    "input by website"
  ];
  if (extraLine) {
    lines.push("", escapeTelegramHtml(extraLine));
  }
  return lines.join("\n");
}

function createPasskeyInactiveText() {
  return [
    "[!] <b>PASS KEY</b> [!]",
    "request reset pass key ini sudah selesai atau sudah tidak aktif.",
    "silakan tekan create lagi dari website."
  ].join("\n");
}

function isPasskeyOtpActive(entry = {}) {
  const otp = String(entry?.pendingOtp?.code || "").trim();
  const expiresAt = Number(entry?.pendingOtp?.expiresAt || 0);
  const messageId = Number(entry?.pendingOtp?.messageId || 0);
  return !!(otp && expiresAt > Date.now() && messageId > 0);
}

function describeTelegramFailure(target, description = "") {
  const normalizedTarget = normalizeTelegramTarget(target);
  const rawDescription = String(description || "Tidak ada detail error.");
  if (normalizedTarget.startsWith("@") && /chat not found/i.test(rawDescription)) {
    return `${rawDescription}. Username Telegram hanya bisa dipakai kalau user tersebut sudah pernah chat / start ke bot. Kalau belum, pakai ID Telegram lebih aman.`;
  }
  return rawDescription;
}

function escapeTelegramHtml(value = "") {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createTelegramLinkToken() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 40);
}

function pruneTelegramLinks(store, maxAgeMs = 15 * 60 * 1000) {
  const now = Date.now();
  store.telegramLinks ||= {};
  for (const [token, item] of Object.entries(store.telegramLinks)) {
    const createdAt = Number(item?.createdAt || 0);
    const completedAt = Number(item?.completedAt || 0);
    const age = completedAt || createdAt;
    if (!age || now - age > maxAgeMs) {
      delete store.telegramLinks[token];
    }
  }
}

async function createTelegramStartHandshake(store, config = {}) {
  pruneTelegramLinks(store);
  const botInfo = await getTelegramBotInfo();
  const token = createTelegramLinkToken();
  const startPayload = config.startPayload || (config.type === "passkey" ? `passkey_${token}` : token);
  store.telegramLinks[token] = {
    token,
    startPayload,
    type: config.type || "register",
    user: config.user || "",
    password: config.password || "",
    telegramTarget: normalizeTelegramTarget(config.telegramTarget || ""),
    websiteUrl: normalizePublicUrl(config.websiteUrl || ""),
    otp: config.otp || "",
    createdAt: Date.now(),
    status: "pending"
  };

  const plainUsername = String(botInfo.username || "").replace(/^@/, "");
  return {
    token,
    needsTelegramStart: true,
    botName: botInfo.username || "@bot",
    botId: botInfo.id || "-",
    startUrl: plainUsername ? `https://t.me/${plainUsername}?start=${encodeURIComponent(startPayload)}` : "",
    message: "Bot belum mendeteksi chat kamu. Buka bot dulu lalu tekan Confirm supaya sistem cek /start dan kirim OTP otomatis.",
    title: "Pengalihan Telegram",
    description: "Bot belum mendeteksi chat kamu. Buka bot dulu, tekan Confirm, lalu sistem akan cek start dan kirim OTP beserta ID Telegram kamu."
  };
}

async function processTelegramPasskeyCallbacks(store) {
  const offset = Number(store.telegramMeta?.lastUpdateId || 0) + 1;
  const updates = await getTelegramUpdates({ offset });
  if (!updates?.ok) {
    return false;
  }

  const result = Array.isArray(updates.result) ? updates.result : [];
  if (!result.length) {
    return false;
  }

  let storeChanged = false;
  let passkeyStore = null;
  let passkeyStoreChanged = false;
  let lastUpdateId = Number(store.telegramMeta?.lastUpdateId || 0);

  for (const update of result) {
    lastUpdateId = Math.max(lastUpdateId, Number(update.update_id || 0));
    const callback = update.callback_query;
    const data = String(callback?.data || "").trim();
    if (!callback || !data.startsWith("passkey_reset:")) {
      continue;
    }

    const user = decodeURIComponent(data.slice("passkey_reset:".length) || "").trim();
    const chatId = String(callback.message?.chat?.id || callback.from?.id || "").trim();
    const messageId = Number(callback.message?.message_id || 0);
    const telegramUsername = callback.from?.username ? `@${callback.from.username}` : "";
    const callbackId = String(callback.id || "").trim();
    if (!user || !chatId || !messageId || !callbackId) {
      continue;
    }

    const regEntry = findLatestUserEntry(
      store.reg,
      (value) => typeof value.user === "string" && value.user === user && value.status === "success"
    );
    if (!regEntry) {
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "User website tidak ditemukan.",
        show_alert: false
      });
      continue;
    }

    const storedTelegram = normalizeTelegramTarget(regEntry.value?.tele || "");
    const usernameMatch = storedTelegram.startsWith("@") && telegramUsername
      ? storedTelegram.toLowerCase() === telegramUsername.toLowerCase()
      : false;
    const idMatch = /^-?\d+$/.test(storedTelegram) ? storedTelegram === chatId : false;
    if (!(usernameMatch || idMatch)) {
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Telegram user tidak cocok dengan data website.",
        show_alert: true
      });
      continue;
    }

    if (!passkeyStore) {
      passkeyStore = await readPasskeyStore();
    }

    const currentEntry = passkeyStore[user] || {};
    const currentOtp = String(currentEntry.pendingOtp?.code || "").trim();
    const now = Date.now();
    const cooldownMs = 5000;
    const lastResetAt = Number(currentEntry.pendingOtp?.lastResetAt || 0);
    const waitingSeconds = Math.max(1, Math.ceil((cooldownMs - (now - lastResetAt)) / 1000));
    const replyMarkup = createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "", currentOtp);
    const activeMessageId = Number(currentEntry.pendingOtp?.messageId || 0);

    if (!currentOtp) {
      await callTelegramApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        text: createPasskeyInactiveText(),
        ...(createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "") ? { reply_markup: createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "") } : {})
      });
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Request reset sudah habis. Buat lagi dari website.",
        show_alert: false
      });
      continue;
    }

    if (activeMessageId && activeMessageId !== messageId) {
      await callTelegramApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        text: createPasskeyInactiveText(),
        ...(createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "") ? { reply_markup: createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "") } : {})
      }).catch(() => {});
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Pesan lama sudah tidak aktif.",
        show_alert: false
      });
      continue;
    }

    if (lastResetAt && now - lastResetAt < cooldownMs) {
      await callTelegramApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        text: createPasskeyOtpText(currentOtp, `Mohon sabar, server sedang berkerja.. ${waitingSeconds}d`),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: `Mohon sabar ${waitingSeconds}d`,
        show_alert: false
      });
      continue;
    }

    const nextOtp = randomDigitCode(5);
    passkeyStore[user] = {
      ...currentEntry,
      user,
      websiteUrl: currentEntry.websiteUrl || "",
      pendingOtp: {
        code: nextOtp,
        expiresAt: now + (5 * 60 * 1000),
        lastResetAt: now,
        chatId,
        messageId
      }
    };
    passkeyStoreChanged = true;

    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text: createPasskeyOtpText(nextOtp),
      ...(createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "", nextOtp) ? { reply_markup: createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "", nextOtp) } : {})
    });
    await callTelegramApi("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Mohon sabar, server sedang berkerja..",
      show_alert: false
    });
  }

  if (passkeyStoreChanged && passkeyStore) {
    await writePasskeyStore(passkeyStore);
  }
  if (lastUpdateId > Number(store.telegramMeta?.lastUpdateId || 0)) {
    store.telegramMeta.lastUpdateId = lastUpdateId;
    storeChanged = true;
  }
  return storeChanged;
}

async function resolveTelegramHandshake(store, token, req = null) {
  pruneTelegramLinks(store);
  const request = store.telegramLinks?.[token];
  if (!request) {
    return { ok: false, status: 404, message: "Permintaan Telegram tidak ditemukan atau sudah kedaluwarsa." };
  }

  if (request.status === "completed") {
    return {
      ok: true,
      linked: true,
      type: request.type,
      message: request.resultMessage || "Telegram berhasil terhubung.",
      telegramUserId: request.telegramUserId || "",
      telegramUsername: request.telegramUsername || ""
    };
  }

  const updates = await getTelegramUpdates();
  if (!updates?.ok) {
    return {
      ok: false,
      status: 502,
      message: updates?.description || "Gagal membaca update Telegram."
    };
  }

  const matchingUpdate = [...(updates.result || [])].reverse().find((update) => {
    const message = update.message || update.edited_message;
    const text = String(message?.text || "").trim();
    if (!text.toLowerCase().startsWith("/start")) {
      return false;
    }
    const payload = text.split(/\s+/, 2)[1] || "";
    return payload === token || payload === request.startPayload;
  });

  if (!matchingUpdate) {
    return {
      ok: true,
      linked: false,
      waiting: true,
      message: "Bot belum mendeteksi /start dari user ini."
    };
  }

  const message = matchingUpdate.message || matchingUpdate.edited_message;
  const chatId = String(message?.chat?.id || "").trim();
  const telegramUsername = message?.from?.username ? `@${message.from.username}` : "";
  if (!chatId) {
    return {
      ok: false,
      status: 400,
      message: "Chat Telegram tidak terbaca."
    };
  }

  if (request.type === "register") {
    const existingUser = findLatestUserEntry(
      store.reg,
      (value) =>
        typeof value.user === "string" &&
        value.user.toLowerCase() === String(request.user || "").toLowerCase() &&
        value.status === "success"
    );
    if (existingUser) {
      request.status = "failed";
      request.resultMessage = "Username sudah dipakai user lain.";
      await writeStore(store);
      return {
        ok: false,
        status: 409,
        message: request.resultMessage
      };
    }

    removeUserEntries(store.reg, request.user);

    const dateKey = formatDateKey();
    const timeKey = formatTimeKey();
    const registerBucket = ensureNestedBucket(store.reg, dateKey, timeKey);
    const registerUserKey = createUniqueUserKey(registerBucket, request.user);
    registerBucket[registerUserKey] = {
      user: request.user,
      display_name: request.user,
      bio: "Belum ada deskripsi user.",
      tele: chatId,
      pass: request.password,
      otprial: request.otp,
      use: "no",
      send: "berhasil kirim",
      status: "pending",
      role: "visitor",
      trusted: "no",
      trusted_ip: "",
      trusted_token: "",
      active_session_token: "",
      blocked: "no",
      hold_until: 0,
      deleted: "no",
      previous_users: []
    };

    const otpMessage = `OTP register: ${request.otp}\nID Telegram kamu: ${chatId}${telegramUsername ? `\nUsername: ${telegramUsername}` : ""}`;
    const sendResult = await sendTelegramMessage(chatId, otpMessage);
    if (!sendResult?.ok) {
      return {
        ok: false,
        status: 502,
        message: describeTelegramFailure(chatId, sendResult?.description || "Gagal kirim OTP register.")
      };
    }

    request.status = "completed";
    request.completedAt = Date.now();
    request.telegramUserId = chatId;
    request.telegramUsername = telegramUsername;
    request.resultMessage = `Bot terhubung. OTP register sudah dikirim. ID Telegram kamu: ${chatId}`;
    appendConsoleLog(store, "success", `Telegram handshake register berhasil: ${request.user} -> ${chatId}`);
    await writeStore(store);
    return {
      ok: true,
      linked: true,
      type: "register",
      message: request.resultMessage,
      telegramUserId: chatId,
      telegramUsername
    };
  }

  if (request.type === "passkey") {
    const regEntry = findLatestUserEntry(
      store.reg,
      (value) => typeof value.user === "string" && value.user === request.user && value.status === "success"
    );
    if (!regEntry) {
      request.status = "failed";
      request.completedAt = Date.now();
      request.resultMessage = "User passkey tidak ditemukan di data website.";
      await writeStore(store);
      return {
        ok: false,
        status: 404,
        message: request.resultMessage
      };
    }

    const storedTelegram = normalizeTelegramTarget(regEntry.value?.tele || request.telegramTarget || "");
    const usernameMatch = storedTelegram.startsWith("@") && telegramUsername
      ? storedTelegram.toLowerCase() === telegramUsername.toLowerCase()
      : false;
    const idMatch = /^-?\d+$/.test(storedTelegram) ? storedTelegram === chatId : false;
    const connectState = usernameMatch || idMatch ? "connect" : "fatal";
    const detectedWebsiteUrl = request.websiteUrl || getPublicBaseUrlFromRequest(req) || getPublicWebsiteUrl();
    const waitingResult = await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: "Waiting..."
    });

    if (connectState === "fatal") {
      const fatalPayload = {
        chat_id: chatId,
        parse_mode: "HTML",
        text: [
          "[!] <b>PassKey</b> [!]",
          `id : <code>${escapeTelegramHtml(chatId)}</code>`,
          `user : <b>${escapeTelegramHtml(request.user)}</b>`,
          "connect : <b>fatal</b>",
          "kode : <tg-spoiler>ditolak karena data Telegram tidak cocok dengan data website</tg-spoiler>"
        ].join("\n")
      };
      const websiteInlineKeyboard = createWebsiteInlineKeyboard(detectedWebsiteUrl);
      if (websiteInlineKeyboard) {
        fatalPayload.reply_markup = websiteInlineKeyboard;
      }
      if (waitingResult?.ok && waitingResult.result?.message_id) {
        await callTelegramApi("deleteMessage", {
          chat_id: chatId,
          message_id: waitingResult.result.message_id
        });
      }
      await callTelegramApi("sendMessage", fatalPayload);
      request.status = "failed";
      request.completedAt = Date.now();
      request.telegramUserId = chatId;
      request.telegramUsername = telegramUsername;
      request.resultMessage = "Fatal: data Telegram yang membuka bot tidak cocok dengan data account website.";
      await writeStore(store);
      return {
        ok: false,
        status: 409,
        message: request.resultMessage
      };
    }

    const passkeyStore = await readPasskeyStore();
    const existingEntry = passkeyStore[request.user] || {};
    const hasActiveOtp = isPasskeyOtpActive(existingEntry);
    const existingOtp = String(existingEntry.pendingOtp?.code || "").trim();
    const existingMessageId = Number(existingEntry.pendingOtp?.messageId || 0);
    const existingChatId = String(existingEntry.pendingOtp?.chatId || "").trim();

    if (hasActiveOtp && existingOtp && existingMessageId > 0 && existingChatId === chatId) {
      if (waitingResult?.ok && waitingResult.result?.message_id) {
        await callTelegramApi("deleteMessage", {
          chat_id: chatId,
          message_id: waitingResult.result.message_id
        }).catch(() => {});
      }
      request.status = "completed";
      request.completedAt = Date.now();
      request.telegramUserId = chatId;
      request.telegramUsername = telegramUsername;
      request.resultMessage = `Telegram sudah cocok. OTP reset passkey masih aktif untuk user ${request.user}.`;
      await writeStore(store);
      return {
        ok: true,
        linked: true,
        type: "passkey",
        message: request.resultMessage,
        telegramUserId: chatId,
        telegramUsername,
        requiresOtp: true
      };
    }

    const otpCode = randomDigitCode(5);
    const replyMarkup = createPasskeyReplyMarkup(request.user, detectedWebsiteUrl, otpCode);
    passkeyStore[request.user] = {
      ...existingEntry,
      user: request.user,
      websiteUrl: detectedWebsiteUrl,
      pendingOtp: {
        code: otpCode,
        expiresAt: Date.now() + (5 * 60 * 1000),
        lastResetAt: Date.now(),
        chatId,
        messageId: 0
      }
    };
    const sendResult = await callTelegramApi("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: createPasskeyOtpText(otpCode),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    if (!sendResult?.ok) {
      return {
        ok: false,
        status: 502,
        message: describeTelegramFailure(chatId, sendResult?.description || "Gagal kirim passkey.")
      };
    }
    if (existingMessageId > 0 && existingChatId === chatId) {
      await callTelegramApi("editMessageText", {
        chat_id: chatId,
        message_id: existingMessageId,
        parse_mode: "HTML",
        text: createPasskeyInactiveText(),
        ...(createPasskeyReplyMarkup(request.user, detectedWebsiteUrl) ? { reply_markup: createPasskeyReplyMarkup(request.user, detectedWebsiteUrl) } : {})
      }).catch(() => {});
    }
    if (waitingResult?.ok && waitingResult.result?.message_id) {
      await callTelegramApi("deleteMessage", {
        chat_id: chatId,
        message_id: waitingResult.result.message_id
      });
    }
    passkeyStore[request.user].pendingOtp.messageId = Number(sendResult.result?.message_id || 0);
    await writePasskeyStore(passkeyStore);

    request.status = "completed";
    request.completedAt = Date.now();
    request.telegramUserId = chatId;
    request.telegramUsername = telegramUsername;
    request.resultMessage = `Telegram sudah cocok. OTP reset passkey sudah dikirim ke Telegram user ${request.user}.`;
    appendConsoleLog(store, "success", `Telegram handshake passkey berhasil: ${request.user} -> ${chatId}`);
    await writeStore(store);
    return {
      ok: true,
      linked: true,
      type: "passkey",
      message: request.resultMessage,
      telegramUserId: chatId,
      telegramUsername,
      requiresOtp: true
    };
  }

  const testMessage = `Bot sudah terhubung.\nID Telegram kamu: ${chatId}${telegramUsername ? `\nUsername: ${telegramUsername}` : ""}`;
  const sendResult = await sendTelegramMessage(chatId, testMessage);
  if (!sendResult?.ok) {
    return {
      ok: false,
      status: 502,
      message: describeTelegramFailure(chatId, sendResult?.description || "Gagal kirim test Telegram.")
    };
  }

  request.status = "completed";
  request.completedAt = Date.now();
  request.telegramUserId = chatId;
  request.telegramUsername = telegramUsername;
  request.resultMessage = `Bot terhubung. ID Telegram kamu: ${chatId}`;
  appendConsoleLog(store, "success", `Telegram handshake test berhasil: ${request.user} -> ${chatId}`);
  await writeStore(store);
  return {
    ok: true,
    linked: true,
    type: "test",
    message: request.resultMessage,
    telegramUserId: chatId,
    telegramUsername
  };
}

async function handleRegister(body, res) {
  const { user, password, confirmPassword, telegram } = body;

  if (!user || !password || !confirmPassword || !telegram) {
    return json(res, 400, { message: "Semua field register wajib diisi." });
  }

  const usernameError = validateUsername(user);
  if (usernameError) {
    return json(res, 400, { message: usernameError });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return json(res, 400, { message: passwordError });
  }
  const telegramError = validateTelegramTarget(telegram);
  if (telegramError) {
    return json(res, 400, { message: telegramError });
  }

  if (password !== confirmPassword) {
    return json(res, 400, { message: "Password dan confirm password tidak sama." });
  }

  const store = await readStore();
  const existingUser = findLatestUserEntry(
    store.reg,
    (value) =>
      typeof value.user === "string" &&
      value.user.toLowerCase() === user.toLowerCase() &&
      value.status === "success"
  );

  if (existingUser) {
    return json(res, 409, { message: "Username sudah terdaftar. Gunakan username lain." });
  }

  const dateKey = formatDateKey();
  const timeKey = formatTimeKey();
  const otp = randomOtp();
  const telegramTarget = normalizeTelegramTarget(telegram);
  const registerMessage = `hallo kak, user regis. seperti ini jika sudah masuk, kami akan mengirim otp ketika menekan button confirm\n\nOTP register: ${otp}`;
  let telegramStatus = "belum kirim";
  let telegramResult = null;

  try {
    telegramResult = await sendTelegramMessage(telegramTarget, registerMessage);
    telegramStatus = telegramResult.ok ? "berhasil kirim" : describeTelegramFailure(telegramTarget, telegramResult.description || "gagal kirim");
  } catch (error) {
    telegramStatus = `gagal kirim: ${error.message}`;
  }

  if (!telegramResult?.ok) {
    if (telegramTarget.startsWith("@") && /chat not found/i.test(String(telegramStatus))) {
      const handshake = await createTelegramStartHandshake(store, {
        type: "register",
        user,
        password,
        telegramTarget,
        otp
      });
      await writeStore(store);
      return json(res, 428, {
        message: `OTP register belum bisa dikirim ke ${telegramTarget}. ${telegramStatus}`,
        ...handshake
      });
    }
    return json(res, 400, {
      message: `OTP register gagal dikirim. ${telegramStatus}`
    });
  }

  removeUserEntries(store.reg, user);

  const registerBucket = ensureNestedBucket(store.reg, dateKey, timeKey);
  const registerUserKey = createUniqueUserKey(registerBucket, user);
  registerBucket[registerUserKey] = {
    user,
    display_name: user,
    bio: "Belum ada deskripsi user.",
    tele: telegramTarget,
    pass: password,
    otprial: otp,
    use: "no",
    send: telegramStatus,
    status: "pending",
    role: "visitor",
    trusted: "no",
    trusted_ip: "",
    trusted_token: "",
    active_session_token: "",
    blocked: "no",
    hold_until: 0,
    deleted: "no",
    previous_users: []
  };

  appendConsoleLog(store, "info", `Register baru dibuat untuk ${user} (${telegramStatus})`);

  await writeStore(store);

  return json(res, 200, {
    message: "OTP register sudah dikirim. Masukkan kode OTP yang dikirim melalui Telegram.",
    sendStatus: telegramStatus
  });
}

async function handleVerifyRegister(body, res) {
  const { user, password, otp } = body;

  if (!user || !password || !otp) {
    return json(res, 400, { message: "User, password, dan OTP register wajib diisi." });
  }

  const store = await readStore();
  const regRecord = findLatestUserEntry(
    store.reg,
    (value) => value.user === user && value.pass === password && value.status === "pending"
  );

  if (!regRecord) {
    return json(res, 404, { message: "Data register tidak ditemukan. Ulangi register dulu." });
  }

  const { dateKey, timeKey, username, value: regValue } = regRecord;
  if (regValue.otprial !== otp) {
    return json(res, 400, { message: "OTP register salah. Cek lagi Telegram kamu." });
  }

  store.reg[dateKey][timeKey][username] = {
    ...regValue,
    use: "yes",
    status: "success"
  };

  appendConsoleLog(store, "success", `Register OTP berhasil diverifikasi: ${user}`);

  await writeStore(store);

  return json(res, 200, {
    message: "DATA TELAH BERHASIL",
    user
  });
}

async function handleTestSend(body, res) {
  const { user, telegram } = body;

  if (!user || !telegram) {
    return json(res, 400, { message: "User dan Telegram wajib diisi untuk test kirim." });
  }

  try {
    const telegramTarget = normalizeTelegramTarget(telegram);
    const telegramResult = await sendTelegramMessage(
      telegramTarget,
      "hallo kak, user regis. seperti ini jika sudah masuk, kami akan mengirim otp ketika menekan button confirm"
    );

    if (!telegramResult.ok) {
      if (telegramTarget.startsWith("@") && /chat not found/i.test(String(telegramResult.description || ""))) {
        const store = await readStore();
        const handshake = await createTelegramStartHandshake(store, {
          type: "test",
          user,
          telegramTarget
        });
        await writeStore(store);
        return json(res, 428, {
          message: `Test kirim belum bisa ke ${telegramTarget}. ${describeTelegramFailure(telegramTarget, telegramResult.description || "chat not found")}`,
          ...handshake
        });
      }
      return json(res, 400, {
        message: `Test kirim gagal untuk ${user}. ${describeTelegramFailure(telegramTarget, telegramResult.description || "Tidak ada detail error.")}`
      });
    }

    return json(res, 200, { message: `Test kirim berhasil untuk ${user}.` });
  } catch (error) {
    return json(res, 500, { message: `Gagal kirim test Telegram: ${error.message}` });
  }
}

async function handleTelegramLinkStatus(body, res, req = null) {
  const { token } = body;
  if (!token) {
    return json(res, 400, { message: "Token Telegram wajib diisi." });
  }

  const store = await readStore();
  const result = await resolveTelegramHandshake(store, String(token).trim(), req);
  if (!result.ok) {
    return json(res, result.status || 400, { message: result.message });
  }

  return json(res, 200, result);
}

async function handleLogin(body, res, req) {
  const { user, password, deviceToken } = body;

  if (!user || !password) {
    return json(res, 400, { message: "User dan password wajib diisi." });
  }

  const store = await readStore();
  const regEntry = findLatestUserEntry(store.reg, (value) =>
    value.user === user &&
    value.pass === password &&
    value.status === "success"
  );

  if (!regEntry) {
    return json(res, 404, { message: "User tidak ditemukan, password salah, atau register belum selesai." });
  }

  const { value: regValue } = regEntry;
  const accountState = getUserAccountState(regEntry);
  if (!accountState.ok) {
    return json(res, 403, { message: accountState.message, state: accountState.reason, holdUntil: accountState.holdUntil || 0 });
  }

  if (isTrustedDeviceMatch(regValue, req, deviceToken)) {
    const sessionToken = createSessionToken();
    setActiveSessionToken(store, user, sessionToken);
    appendConsoleLog(store, "success", `Auto login trusted device: ${user}`);
    await writeStore(store);
    return json(res, 200, {
      message: "Login otomatis berhasil dari perangkat terpercaya.",
      autoLogin: true,
      user,
      role: regValue.role || "visitor",
      sessionToken
    });
  }

  const dateKey = formatDateKey();
  const timeKey = formatTimeKey();
  const otp = randomOtp();
  let telegramStatus = "belum kirim";

  try {
    const telegramResult = await sendTelegramMessage(regValue.tele, `OTP login sekali pakai untuk ${user}: ${otp}`);
    telegramStatus = telegramResult.ok ? "berhasil kirim" : (telegramResult.description || "gagal kirim");
  } catch (error) {
    telegramStatus = `gagal kirim: ${error.message}`;
  }

  removeUserEntries(store.log, user);
  removeUserEntries(store["log-otp"], user);

  const logBucket = ensureNestedBucket(store.log, dateKey, timeKey);
  const logUserKey = createUniqueUserKey(logBucket, user);
  logBucket[logUserKey] = {
    user,
    tele: regValue.tele,
    pass: password,
    send: telegramStatus
  };

  const otpBucket = ensureNestedBucket(store["log-otp"], dateKey, timeKey);
  const otpUserKey = createUniqueUserKey(otpBucket, user);
  otpBucket[otpUserKey] = {
    user,
    tele: regValue.tele,
    pass: password,
    otprial: otp,
    use: "no",
    send: telegramStatus
  };

  appendConsoleLog(store, "info", `OTP login dibuat untuk ${user} (${telegramStatus})`);

  await writeStore(store);

  return json(res, 200, {
    message: "OTP sudah dikirim ke Telegram. Silakan ketik sendiri OTP-nya.",
    sendStatus: telegramStatus
  });
}

async function handleVerifyLogin(body, res, req) {
  const { user, password, otp, trustDevice, deviceToken } = body;

  if (!user || !password || !otp) {
    return json(res, 400, { message: "User, password, dan OTP wajib diisi." });
  }

  const store = await readStore();
  const otpRecord = findLatestUserEntry(
    store["log-otp"],
    (value) => value.user === user && value.pass === password && value.use !== "yes"
  );

  if (!otpRecord) {
    return json(res, 404, { message: "Data OTP login tidak ditemukan. Ulangi login dulu." });
  }

  const { dateKey, timeKey, username, value: otpValue } = otpRecord;
  const passkeyStore = await readPasskeyStore();
  const passkeyCodes = Array.isArray(passkeyStore?.[user]?.codes) ? passkeyStore[user].codes : [];
  const usingPasskey = passkeyCodes.includes(String(otp).trim());

  if (otpValue.otprial !== otp && !usingPasskey) {
    return json(res, 400, { message: "OTP salah. Cek lagi Telegram kamu." });
  }

  store["log-otp"][dateKey][timeKey][username] = {
    ...otpValue,
    use: "yes"
  };

  const regRecord = findLatestUserEntry(store.reg, (value) =>
    value.user === user &&
    value.pass === password &&
    value.status === "success"
  );

  if (regRecord) {
    const { dateKey: regDateKey, timeKey: regTimeKey, username: regUsername, value: regValue } = regRecord;
    store.reg[regDateKey][regTimeKey][regUsername] = {
      ...regValue,
      trusted: trustDevice ? "yes" : "no",
      trusted_ip: trustDevice ? getClientIp(req) : "",
      trusted_token: trustDevice ? normalizeDeviceToken(deviceToken) : ""
    };
  }

  const sessionToken = createSessionToken();
  setActiveSessionToken(store, user, sessionToken);

  ensureNestedBucket(store.log, dateKey, timeKey)[user] = {
    user,
    tele: otpValue.tele,
    pass: password,
    otprial: otp,
    percya: trustDevice ? "yes" : "no",
    ip: getClientIp(req),
    send: otpValue.send
  };

  appendConsoleLog(store, "success", `Login berhasil: ${user}${trustDevice ? " [trusted]" : ""}`);

  await writeStore(store);

  return json(res, 200, {
    message: "Login berhasil.",
    user,
    trusted: trustDevice ? "yes" : "no",
    role: regRecord?.value?.role || "visitor",
    sessionToken
  });
}

async function handleAutoSession(body, res, req) {
  const { user, deviceToken } = body;
  if (!user || !normalizeDeviceToken(deviceToken)) {
    return json(res, 400, { message: "User dan token perangkat wajib diisi." });
  }

  const store = await readStore();
  const regRecord = findLatestUserEntry(store.reg, (value) =>
    value.user === user &&
    value.status === "success" &&
    isTrustedDeviceMatch(value, req, deviceToken)
  );

  if (!regRecord) {
    return json(res, 404, { message: "Tidak ada sesi otomatis yang cocok." });
  }

  const accountState = getUserAccountState(regRecord);
  if (!accountState.ok) {
    return json(res, 403, { message: accountState.message, state: accountState.reason, holdUntil: accountState.holdUntil || 0 });
  }

  const sessionToken = createSessionToken();
  setActiveSessionToken(store, user, sessionToken);
  await writeStore(store);

  return json(res, 200, {
    message: "Sesi otomatis ditemukan.",
    user,
    role: regRecord.value.role || "visitor",
    sessionToken
  });
}

function buildDashboardData(store) {
  const regEntries = collectUserEntries(store.reg)
    .filter((entry) => entry.value.status === "success")
    .sort((a, b) => toTimestamp(b.dateKey, b.timeKey) - toTimestamp(a.dateKey, a.timeKey));

  const latestUserMap = new Map();
  for (const entry of regEntries) {
    if (!latestUserMap.has(entry.value.user)) {
      latestUserMap.set(entry.value.user, entry);
    }
  }

  const logEntries = collectUserEntries(store.log)
    .sort((a, b) => toTimestamp(b.dateKey, b.timeKey) - toTimestamp(a.dateKey, a.timeKey));

  const latestLoginMap = new Map();
  for (const entry of logEntries) {
    if (!latestLoginMap.has(entry.value.user)) {
      latestLoginMap.set(entry.value.user, `${entry.dateKey} ${entry.timeKey.replaceAll("-", ":")}`);
    }
  }

  const users = Array.from(latestUserMap.values()).map((entry) => ({
    user: entry.value.user,
    displayName: entry.value.display_name || entry.value.user,
    role: entry.value.role || "visitor",
    registeredAt: `${entry.dateKey} ${entry.timeKey.replaceAll("-", ":")}`,
    lastLogin: latestLoginMap.get(entry.value.user) || entry.dateKey,
    status: getStatusFromValue(entry.value),
    online: isUserOnline(entry.value),
    holdUntil: Number(entry.value.hold_until || 0),
    tele: entry.value.tele || "",
    previousUsers: Array.isArray(entry.value.previous_users) ? entry.value.previous_users : []
  }));

  const roleGroups = {};
  for (const user of users) {
    const role = user.role || "visitor";
    roleGroups[role] ||= [];
    roleGroups[role].push(user);
  }

  const chart = Object.entries(roleGroups).map(([label, items]) => ({
    label: label[0].toUpperCase() + label.slice(1),
    total: items.length
  }));

  const now = new Date();
  const timelineMap = new Map();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - offset);
    const dateKey = formatDateKey(day);
    timelineMap.set(dateKey, {
      dateKey,
      shortLabel: day.toLocaleDateString("id-ID", { weekday: "short" }),
      fullLabel: day.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }),
      visits: 0,
      uniqueUsers: new Set()
    });
  }

  for (const entry of logEntries) {
    const bucket = timelineMap.get(entry.dateKey);
    if (!bucket) {
      continue;
    }
    bucket.visits += 1;
    if (entry.value?.user) {
      bucket.uniqueUsers.add(String(entry.value.user).toLowerCase());
    }
  }

  const visitsTimeline = Array.from(timelineMap.values()).map((bucket) => ({
    dateKey: bucket.dateKey,
    shortLabel: bucket.shortLabel,
    fullLabel: bucket.fullLabel,
    visits: bucket.visits,
    uniqueUsers: bucket.uniqueUsers.size
  }));

  return {
    totalUsers: users.filter((user) => user.status !== "deleted").length,
    users,
    roleCounts: Object.fromEntries(Object.entries(roleGroups).map(([role, items]) => [role, items.length])),
    roles: roleGroups,
    chart,
    visitsTimeline
  };
}

async function handleDashboard(res) {
  const store = await readStore();
  return json(res, 200, buildDashboardData(store));
}

async function handleSearch(body, res) {
  const { user, sessionToken, query } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  return json(res, 200, buildSearchData(store, query));
}

async function handlePublicSearch(body, res) {
  const { query } = body;
  const store = await readStore();
  return json(res, 200, buildSearchData(store, query));
}

async function handleConsoleLogs(res) {
  const store = await readStore();
  return json(res, 200, {
    logs: (store.consoleLogs || []).slice(-120),
    roles: listAllRoles(store)
  });
}

async function handleAdminAddUser(body, res) {
  const { user, password, telegram, role, customRole } = body;
  if (!user || !password || !telegram) {
    return json(res, 400, { message: "User, password, dan Telegram wajib diisi." });
  }

  const usernameError = validateUsername(user);
  if (usernameError) {
    return json(res, 400, { message: usernameError });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return json(res, 400, { message: passwordError });
  }
  const telegramError = validateTelegramTarget(telegram);
  if (telegramError) {
    return json(res, 400, { message: telegramError });
  }

  const finalRole = String(role === "costume" ? customRole : role || "visitor").trim().toLowerCase();
  if (!finalRole) {
    return json(res, 400, { message: "Role custom wajib diisi." });
  }

  const store = await readStore();
  const existingUser = findLatestUserEntry(store.reg, (value) => typeof value.user === "string" && value.user.toLowerCase() === user.toLowerCase());
  if (existingUser) {
    return json(res, 409, { message: "Username sudah terdaftar. Gunakan username lain." });
  }

  const dateKey = formatDateKey();
  const timeKey = formatTimeKey();
  const bucket = ensureNestedBucket(store.reg, dateKey, timeKey);
  const userKey = createUniqueUserKey(bucket, user);
  bucket[userKey] = {
    user,
    display_name: user,
    bio: "Belum ada deskripsi user.",
    tele: telegram,
    pass: password,
    otprial: "",
    use: "yes",
    send: "owner-add-user",
    status: "success",
    role: finalRole,
    trusted: "no",
    trusted_ip: "",
    trusted_token: "",
    active_session_token: "",
    blocked: "no",
    hold_until: 0,
    deleted: "no",
    previous_users: []
  };

  appendConsoleLog(store, "success", `Owner add user: ${user} role=${bucket[userKey].role}`);

  await writeStore(store);
  return json(res, 200, { message: "User berhasil ditambahkan.", user, role: bucket[userKey].role });
}

async function handleAdminAction(body, res) {
  const { user, action, durationSeconds, role, actor } = body;
  if (!action) {
    return json(res, 400, { message: "Action wajib diisi." });
  }

  const store = await readStore();
  const result = runAdminAction(store, { user, action, durationSeconds, role, actor });
  if (result.error) {
    const statusCode = result.error.includes("tidak ditemukan") ? 404 : 400;
    return json(res, statusCode, { message: result.error });
  }
  await writeStore(store);
  return json(res, 200, result);
}

async function handleConsoleCommand(body, res) {
  const { command, actor, sessionToken } = body;
  const store = await readStore();
  const ownerCheck = ensureOwnerSession(store, actor, sessionToken);
  if (!ownerCheck.ok) {
    return json(res, ownerCheck.statusCode, { message: ownerCheck.message });
  }
  const result = executeConsoleCommand(store, command, actor);
  if (result.error) {
    appendConsoleLog(store, "error", result.error);
    await writeStore(store);
    return json(res, 400, { message: result.error });
  }
  if (Array.isArray(result.output)) {
    result.output.forEach((line) => appendConsoleLog(store, "output", line));
  }
  await writeStore(store);
  return json(res, 200, {
    message: result.message || "Command berhasil dijalankan.",
    output: result.output || [],
    download: result.download || null
  });
}

async function handleFileManager(body, res) {
  const { user, sessionToken, targetPath } = body;
  try {
    const store = await readStore();
    const ownerCheck = ensureOwnerSession(store, user, sessionToken);
    if (!ownerCheck.ok) {
      return json(res, ownerCheck.statusCode, { message: ownerCheck.message });
    }
    const payload = await buildFileManagerPayload(targetPath);
    return json(res, 200, payload);
  } catch (error) {
    return json(res, 400, { message: error.message || "Folder file manager gagal dibuka." });
  }
}

async function handleFilePreview(body, res) {
  const { user, sessionToken, targetPath } = body;
  try {
    const store = await readStore();
    const ownerCheck = ensureOwnerSession(store, user, sessionToken);
    if (!ownerCheck.ok) {
      return json(res, ownerCheck.statusCode, { message: ownerCheck.message });
    }
    const payload = await readManagedFile(targetPath);
    return json(res, 200, payload);
  } catch (error) {
    return json(res, 400, { message: error.message || "Preview file gagal dibuka." });
  }
}

async function handleSessionStatus(body, res) {
  const { user, sessionToken } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  let telegramChanged = false;
  try {
    telegramChanged = await processTelegramPasskeyCallbacks(store);
  } catch (error) {
    appendConsoleLog(store, "error", `Telegram callback check gagal: ${error.message || "unknown error"}`);
  }
  const changed = clearExpiredEvents(store, user);
  const regRecord = findLatestUserEntry(store.reg, (value) => value.user === user);
  const state = getUserAccountState(regRecord);
  if (telegramChanged || changed) {
    await writeStore(store);
  }
  return json(res, 200, {
    events: store.events[user] || [],
    state
  });
}

async function handleProfile(body, res) {
  const { user, sessionToken } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const mediaStore = await readProfileMediaStore();
  const profile = getProfilePayload(store, user, mediaStore);
  if (!profile) {
    return json(res, 404, { message: "Profil user tidak ditemukan." });
  }

  return json(res, 200, { profile });
}

async function handleThemeConfig(body, res) {
  const { user, sessionToken } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const themeStore = await readThemeConfigStore();
  return json(res, 200, {
    config: getUserThemeConfig(themeStore, user)
  });
}

async function handleThemeConfigSave(body, res) {
  const { user, sessionToken, config } = body;
  if (!user || !sessionToken || !config) {
    return json(res, 400, { message: "User, session token, dan config wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const normalizedConfig = normalizeThemeConfigInput(config);
  const themeStore = await readThemeConfigStore();
  themeStore.users = themeStore.users && typeof themeStore.users === "object" ? themeStore.users : {};
  themeStore.users[String(user).trim()] = {
    ...normalizedConfig,
    updatedAt: Date.now()
  };
  await writeThemeConfigStore(themeStore);

  return json(res, 200, {
    message: "Config tema berhasil disimpan.",
    config: getUserThemeConfig(themeStore, user)
  });
}

async function handlePublicProfile(body, res) {
  const { targetUser } = body;
  if (!targetUser) {
    return json(res, 400, { message: "Target user wajib diisi." });
  }
  const store = await readStore();
  const mediaStore = await readProfileMediaStore();
  const profile = getPublicProfilePayload(store, String(targetUser).trim(), mediaStore);
  if (!profile) {
    return json(res, 404, { message: "Profil user tidak ditemukan." });
  }
  const viewer = getViewerFromSession(store, body?.user, body?.sessionToken);
  const posts = await getPostsByUser(store, profile.user, 24, viewer);
  return json(res, 200, { profile, posts });
}

async function handlePostList(body, res) {
  const store = await readStore();
  const limit = Number(body?.limit || 24);
  const viewer = getViewerFromSession(store, body?.user, body?.sessionToken);
  const posts = await getPublicPostFeed(store, limit, viewer);
  return json(res, 200, { posts });
}

async function handlePostDetail(body, res) {
  const safeUser = String(body?.targetUser || "").trim().replace(/^@+/, "");
  const safeShareCode = sanitizePostShareCode(body?.shareCode || "");
  if (!safeUser || !safeShareCode) {
    return json(res, 400, { message: "Target user dan kode post wajib diisi." });
  }
  const store = await readStore();
  const viewer = getViewerFromSession(store, body?.user, body?.sessionToken);
  const post = await findPostByShareCode(safeUser, safeShareCode);
  if (!post || String(post.visibility || "public") !== "public" || !String(post.content || "").trim()) {
    return json(res, 404, { message: "Posting tidak ditemukan." });
  }
  return json(res, 200, {
    post: toPublicPostPayload(store, post, viewer)
  });
}

async function handlePostCreate(body, res) {
  const { user, sessionToken, content, category } = body;
  const safeUser = String(user || "").trim();
  const safeContent = String(content || "").trim();
  const safeCategory = String(category || "POSTINGAN").trim().toUpperCase();
  const allowedCategories = new Set(["ARTIKEL", "POSTINGAN", "TUTORIAL"]);
  if (!safeUser || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }
  if (!safeContent) {
    return json(res, 400, { message: "Isi posting tidak boleh kosong." });
  }
  if (safeContent.length > POST_CONTENT_MAX) {
    return json(res, 400, { message: `Isi posting maksimal ${POST_CONTENT_MAX} karakter.` });
  }
  if (!allowedCategories.has(safeCategory)) {
    return json(res, 400, { message: "Kategori post tidak valid." });
  }

  const store = await readStore();
  if (!hasValidSession(store, safeUser, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const author = getPostAuthorSnapshot(store, safeUser);
  if (!author) {
    return json(res, 404, { message: "Profil user tidak ditemukan." });
  }

  const now = Date.now();
  const post = {
    id: createPostId(safeUser),
    user: safeUser,
    author,
    content: safeContent,
    category: safeCategory,
    visibility: "public",
    likes: [],
    reposts: [],
    comments: [],
    createdAt: now,
    updatedAt: now
  };

  await writePostEntry(post);
  appendConsoleLog(store, "info", `[${safeUser}] Membuat posting baru`);
  await writeStore(store);
  return json(res, 200, {
    message: "Posting berhasil dikirim.",
    post: toPublicPostPayload(store, post, safeUser)
  });
}

async function handlePostAction(body, res) {
  const { user, sessionToken, postId, action } = body;
  const safeUser = String(user || "").trim();
  const safeAction = String(action || "").trim().toLowerCase();
  if (!safeUser || !sessionToken || !postId) {
    return json(res, 400, { message: "User, session token, post, dan action wajib diisi." });
  }
  if (!["like", "repost"].includes(safeAction)) {
    return json(res, 400, { message: "Aksi post tidak valid." });
  }

  const store = await readStore();
  if (!hasValidSession(store, safeUser, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const post = await readPostEntry(postId);
  const collectionKey = safeAction === "like" ? "likes" : "reposts";
  const current = Array.isArray(post[collectionKey]) ? [...post[collectionKey]] : [];
  const targetIndex = current.findIndex((item) => String(item || "").toLowerCase() === safeUser.toLowerCase());
  let message = "";
  if (targetIndex >= 0) {
    current.splice(targetIndex, 1);
    message = safeAction === "like" ? "Like dibatalkan." : "Repost dibatalkan.";
  } else {
    current.push(safeUser);
    message = safeAction === "like" ? "Posting disukai." : "Posting direpost.";
  }
  post[collectionKey] = current;
  await writePostEntry(post);
  return json(res, 200, {
    message,
    post: toPublicPostPayload(store, post, safeUser)
  });
}

async function handlePostComment(body, res) {
  const { user, sessionToken, postId, content, replyToCommentId, replyToUser } = body;
  const safeUser = String(user || "").trim();
  const safeContent = String(content || "").trim();
  const safeReplyToCommentId = String(replyToCommentId || "").trim();
  const safeReplyToUser = String(replyToUser || "").trim();
  if (!safeUser || !sessionToken || !postId) {
    return json(res, 400, { message: "User, session token, dan post wajib diisi." });
  }
  if (!safeContent) {
    return json(res, 400, { message: "Komentar tidak boleh kosong." });
  }
  if (safeContent.length > POST_COMMENT_MAX) {
    return json(res, 400, { message: `Komentar maksimal ${POST_COMMENT_MAX} karakter.` });
  }

  const store = await readStore();
  if (!hasValidSession(store, safeUser, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const post = await readPostEntry(postId);
  const comments = Array.isArray(post.comments) ? [...post.comments] : [];
  if (safeReplyToCommentId && !comments.some((item) => String(item?.id || "") === safeReplyToCommentId)) {
    return json(res, 404, { message: "Komentar yang dibalas tidak ditemukan." });
  }
  comments.push({
    id: createCommentId(safeUser),
    user: safeUser,
    content: safeContent,
    createdAt: Date.now(),
    replyToCommentId: safeReplyToCommentId,
    replyToUser: safeReplyToUser
  });
  post.comments = comments;
  await writePostEntry(post);
  return json(res, 200, {
    message: "Komentar berhasil dikirim.",
    post: toPublicPostPayload(store, post, safeUser)
  });
}

async function handlePostCommentUpdate(body, res) {
  const { user, sessionToken, postId, commentId, content } = body;
  const safeUser = String(user || "").trim();
  const safeCommentId = String(commentId || "").trim();
  const safeContent = String(content || "").trim();
  if (!safeUser || !sessionToken || !postId || !safeCommentId) {
    return json(res, 400, { message: "User, session token, post, dan komentar wajib diisi." });
  }
  if (!safeContent) {
    return json(res, 400, { message: "Komentar tidak boleh kosong." });
  }
  if (safeContent.length > POST_COMMENT_MAX) {
    return json(res, 400, { message: `Komentar maksimal ${POST_COMMENT_MAX} karakter.` });
  }

  const store = await readStore();
  if (!hasValidSession(store, safeUser, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const post = await readPostEntry(postId);
  const comments = Array.isArray(post.comments) ? [...post.comments] : [];
  const commentIndex = comments.findIndex((item) => String(item?.id || "") === safeCommentId);
  if (commentIndex < 0) {
    return json(res, 404, { message: "Komentar tidak ditemukan." });
  }
  if (String(comments[commentIndex].user || "").trim().toLowerCase() !== safeUser.toLowerCase()) {
    return json(res, 403, { message: "Kamu hanya bisa edit komentar milik sendiri." });
  }
  comments[commentIndex] = {
    ...comments[commentIndex],
    content: safeContent,
    updatedAt: Date.now()
  };
  post.comments = comments;
  await writePostEntry(post);
  return json(res, 200, {
    message: "Komentar berhasil diupdate.",
    post: toPublicPostPayload(store, post, safeUser)
  });
}

async function handlePostCommentDelete(body, res) {
  const { user, sessionToken, postId, commentId } = body;
  const safeUser = String(user || "").trim();
  const safeCommentId = String(commentId || "").trim();
  if (!safeUser || !sessionToken || !postId || !safeCommentId) {
    return json(res, 400, { message: "User, session token, post, dan komentar wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, safeUser, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const post = await readPostEntry(postId);
  const comments = Array.isArray(post.comments) ? [...post.comments] : [];
  const commentIndex = comments.findIndex((item) => String(item?.id || "") === safeCommentId);
  if (commentIndex < 0) {
    return json(res, 404, { message: "Komentar tidak ditemukan." });
  }
  if (String(comments[commentIndex].user || "").trim().toLowerCase() !== safeUser.toLowerCase()) {
    return json(res, 403, { message: "Kamu hanya bisa hapus komentar milik sendiri." });
  }
  comments.splice(commentIndex, 1);
  post.comments = comments;
  await writePostEntry(post);
  return json(res, 200, {
    message: "Komentar berhasil dihapus.",
    post: toPublicPostPayload(store, post, safeUser),
    commentId: safeCommentId
  });
}

async function handlePostUpdate(body, res) {
  const { user, sessionToken, postId, content, category } = body;
  const safeUser = String(user || "").trim();
  const safeContent = String(content || "").trim();
  const safeCategory = String(category || "POSTINGAN").trim().toUpperCase();
  const allowedCategories = new Set(["ARTIKEL", "POSTINGAN", "TUTORIAL"]);
  if (!safeUser || !sessionToken || !postId) {
    return json(res, 400, { message: "User, session token, dan post wajib diisi." });
  }
  if (!safeContent) {
    return json(res, 400, { message: "Isi posting tidak boleh kosong." });
  }
  if (safeContent.length > POST_CONTENT_MAX) {
    return json(res, 400, { message: `Isi posting maksimal ${POST_CONTENT_MAX} karakter.` });
  }
  if (!allowedCategories.has(safeCategory)) {
    return json(res, 400, { message: "Kategori post tidak valid." });
  }

  const store = await readStore();
  if (!hasValidSession(store, safeUser, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const post = await readPostEntry(postId);
  if (String(post.user || "").trim().toLowerCase() !== safeUser.toLowerCase()) {
    return json(res, 403, { message: "Kamu hanya bisa edit posting milik sendiri." });
  }

  post.content = safeContent;
  post.category = safeCategory;
  post.updatedAt = Date.now();
  await writePostEntry(post);
  return json(res, 200, {
    message: "Posting berhasil diupdate.",
    post: toPublicPostPayload(store, post, safeUser)
  });
}

async function handlePostDelete(body, res) {
  const { user, sessionToken, postId } = body;
  const safeUser = String(user || "").trim();
  if (!safeUser || !sessionToken || !postId) {
    return json(res, 400, { message: "User, session token, dan post wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, safeUser, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const post = await readPostEntry(postId);
  if (String(post.user || "").trim().toLowerCase() !== safeUser.toLowerCase()) {
    return json(res, 403, { message: "Kamu hanya bisa hapus posting milik sendiri." });
  }

  if (useRemoteStore()) {
    const safeId = String(postId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
    const posts = await readPostStore();
    await writeRemoteJsonStore(
      POST_STORE_KEY,
      posts.filter((item) => String(item?.id || "") !== safeId)
    );
  } else {
    const filePath = getPostFilePath(postId);
    await fs.unlink(filePath);
  }
  return json(res, 200, {
    message: "Posting berhasil dihapus.",
    postId: String(postId)
  });
}

async function handleProfileUpdate(body, res) {
  const { user, sessionToken, field, value } = body;
  if (!user || !sessionToken || !field) {
    return json(res, 400, { message: "User, session token, dan field wajib diisi." });
  }

  const store = await readStore();
  const mediaStore = await readProfileMediaStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const profileEntry = findLatestUserEntry(store.reg, (item) => item.user === user && item.status === "success");
  if (!profileEntry) {
    return json(res, 404, { message: "Profil user tidak ditemukan." });
  }

  const normalizedField = String(field).trim().toLowerCase();
  const trimmedValue = String(value || "").trim();

  if (normalizedField === "display_name") {
    const displayNameError = validateDisplayName(trimmedValue);
    if (displayNameError) {
      return json(res, 400, { message: displayNameError });
    }
    updateAllUserEntries(store.reg, user, (item) => ({
      ...item,
      display_name: trimmedValue
    }));
    appendConsoleLog(store, "info", `[${user}] Update display name -> ${trimmedValue}`);
    await writeStore(store);
    return json(res, 200, {
      message: "Nama panggilan berhasil diperbarui.",
      profile: getProfilePayload(store, user, mediaStore)
    });
  }

  if (normalizedField === "bio") {
    if (!trimmedValue) {
      return json(res, 400, { message: "Deskripsi user tidak boleh kosong." });
    }
    if (trimmedValue.length > 100) {
      return json(res, 400, { message: "Deskripsi user maksimal 100 karakter." });
    }
    updateAllUserEntries(store.reg, user, (item) => ({
      ...item,
      bio: trimmedValue
    }));
    appendConsoleLog(store, "info", `[${user}] Update bio profile`);
    await writeStore(store);
    return json(res, 200, {
      message: "Deskripsi user berhasil diperbarui.",
      profile: getProfilePayload(store, user, mediaStore)
    });
  }

  if (normalizedField === "pass") {
    if (!trimmedValue) {
      return json(res, 400, { message: "Password baru tidak boleh kosong." });
    }
    const passwordError = validatePassword(trimmedValue);
    if (passwordError) {
      return json(res, 400, { message: passwordError });
    }
    if (trimmedValue === profileEntry.value.pass) {
      return json(res, 400, { message: "Password baru tidak boleh sama dengan password sebelumnya." });
    }
    updateAllUserEntries(store.reg, user, (item) => ({
      ...item,
      pass: trimmedValue
    }));
    appendConsoleLog(store, "info", `[${user}] Update password profile`);
    await writeStore(store);
    return json(res, 200, {
      message: "Password berhasil diperbarui.",
      profile: getProfilePayload(store, user, mediaStore)
    });
  }

  if (normalizedField === "user") {
    if (!trimmedValue) {
      return json(res, 400, { message: "Username baru tidak boleh kosong." });
    }
    const usernameError = validateUsername(trimmedValue);
    if (usernameError) {
      return json(res, 400, { message: usernameError });
    }
    if (trimmedValue.toLowerCase() === user.toLowerCase()) {
      return json(res, 400, { message: "Username baru tidak boleh sama dengan username sekarang." });
    }
    const existingUser = findLatestUserEntry(
      store.reg,
      (item) => typeof item.user === "string" && item.user.toLowerCase() === trimmedValue.toLowerCase()
    );
    if (existingUser) {
      return json(res, 409, { message: "Username sudah dipakai user lain." });
    }

    const previousUsers = Array.isArray(profileEntry.value.previous_users) ? profileEntry.value.previous_users : [];
    const mergedHistory = Array.from(new Set([...previousUsers, user]));

    updateAllUserEntries(store.reg, user, (item) => ({
      ...item,
      user: trimmedValue,
      display_name: item.display_name || trimmedValue,
      previous_users: Array.from(new Set([...(Array.isArray(item.previous_users) ? item.previous_users : []), user]))
    }));
    updateAllUserEntries(store.log, user, (item) => ({
      ...item,
      user: trimmedValue
    }));
    updateAllUserEntries(store["log-otp"], user, (item) => ({
      ...item,
      user: trimmedValue
    }));
    if (store.events[user]) {
      store.events[trimmedValue] = [...(store.events[trimmedValue] || []), ...store.events[user]];
      delete store.events[user];
    }

    setActiveSessionToken(store, trimmedValue, sessionToken);
    appendConsoleLog(store, "info", `[${user}] Ganti username -> ${trimmedValue} | sebelumnya: ${mergedHistory.join(", ")}`);
    await writeStore(store);
    if (mediaStore.users?.[user]) {
      mediaStore.users[trimmedValue] = {
        ...(mediaStore.users[trimmedValue] || {}),
        ...mediaStore.users[user]
      };
      delete mediaStore.users[user];
      await writeProfileMediaStore(mediaStore);
    }
    return json(res, 200, {
      message: "Username berhasil diperbarui.",
      profile: getProfilePayload(store, trimmedValue, mediaStore),
      nextUser: trimmedValue
    });
  }

  return json(res, 400, { message: "Field profil tidak dikenali." });
}

async function handleProfileMediaUpdate(body, res) {
  const { user, sessionToken, target, dataUrl } = body;
  if (!user || !sessionToken || !target || !dataUrl) {
    return json(res, 400, { message: "User, session token, target, dan file wajib diisi." });
  }

  const safeTarget = String(target || "").trim().toLowerCase();
  if (!["avatar", "cover"].includes(safeTarget)) {
    return json(res, 400, { message: "Target media profil tidak valid." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const profileEntry = findLatestUserEntry(store.reg, (item) => item.user === user && item.status === "success");
  if (!profileEntry) {
    return json(res, 404, { message: "Profil user tidak ditemukan." });
  }

  const match = String(dataUrl || "").match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    return json(res, 400, { message: "Format gambar tidak didukung. Gunakan PNG, JPG, atau WEBP." });
  }

  const mime = String(match[1] || "").toLowerCase();
  const extMap = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp" };
  const ext = extMap[mime];
  if (!ext) {
    return json(res, 400, { message: "Ekstensi gambar tidak valid." });
  }

  const base64Data = String(match[2] || "");
  const buffer = Buffer.from(base64Data, "base64");
  if (!buffer.length || buffer.length > 2.5 * 1024 * 1024) {
    return json(res, 400, { message: "Ukuran gambar harus di bawah 2.5MB." });
  }

  const safeUser = sanitizeMediaUserKey(user);
  const fileName = `${safeUser}.${ext}`;
  let relativeUrl = dataUrl;
  if (!useRemoteStore()) {
    await ensureProfileMediaStore();
    const folder = safeTarget === "avatar" ? PROFILE_AVATAR_DIR : PROFILE_COVER_DIR;
    const filePath = path.join(folder, fileName);
    await fs.writeFile(filePath, buffer);
    relativeUrl = `${safeTarget === "avatar" ? "/data/user/files/pro/" : "/data/user/files/prosub/"}${encodeURIComponent(fileName)}?v=${Date.now()}`;
  }

  const mediaStore = await readProfileMediaStore();
  mediaStore.users ||= {};
  mediaStore.users[user] ||= {};
  if (safeTarget === "avatar") {
    mediaStore.users[user].avatarUrl = relativeUrl;
  } else {
    mediaStore.users[user].coverUrl = relativeUrl;
  }
  mediaStore.users[user].updatedAt = Date.now();
  await writeProfileMediaStore(mediaStore);

  return json(res, 200, {
    message: safeTarget === "avatar" ? "Foto profil berhasil diperbarui." : "Cover profil berhasil diperbarui.",
    profile: getProfilePayload(store, user, mediaStore)
  });
}

async function handlePasskeyStatus(body, res) {
  const { user, sessionToken } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const passkeyStore = await readPasskeyStore();
  return json(res, 200, {
    passkey: getPasskeyPayload(passkeyStore, user)
  });
}

async function handlePasskeyGenerate(body, res, req = null) {
  const { user, sessionToken, otp } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const regEntry = findLatestUserEntry(store.reg, (value) => value.user === user && value.status === "success");
  if (!regEntry) {
    return json(res, 404, { message: "User tidak ditemukan untuk passkey." });
  }

  const passkeyStore = await readPasskeyStore();
  const currentEntry = passkeyStore[user] || {};
  const hasExistingCodes = Array.isArray(currentEntry.codes) && currentEntry.codes.length > 0;
  const otpValue = String(otp || "").trim();

  if (!otpValue) {
    const teleTarget = normalizeTelegramTarget(regEntry.value.tele || "");
    try {
      const handshake = await createTelegramStartHandshake(store, {
        type: "passkey",
        user,
        telegramTarget: teleTarget,
        websiteUrl: getPublicBaseUrlFromRequest(req) || getPublicWebsiteUrl()
      });
      handshake.title = "Pengalihan Telegram";
      handshake.description = "Ini adalah command, pencocokkan id antara pengguna dan telegram. Jika sama, kami akan mengirimkan OTP reset passkey langsung dari bot.";
      handshake.message = hasExistingCodes
        ? "Buka bot dulu, tekan Confirm, lalu sistem akan cek /passkey dan kirim OTP reset passkey."
        : "Buka bot dulu, tekan Confirm, lalu sistem akan cek /passkey dan mengirim OTP reset passkey pertamamu.";
      handshake.confirmLabel = "Confirm";
      await writeStore(store);
      return json(res, 428, {
        message: "Passkey perlu disambungkan lewat Telegram dulu.",
        ...handshake
      });
    } catch (error) {
      return json(res, 500, { message: `Gagal menyiapkan pengalihan passkey: ${error.message}` });
    }
  }

  const pendingOtp = currentEntry.pendingOtp;
  if (!pendingOtp?.code || Number(pendingOtp.expiresAt || 0) < Date.now()) {
    return json(res, 400, { message: "OTP passkey sudah habis atau belum dibuat. Tekan create lagi." });
  }
  if (pendingOtp.code !== otpValue) {
    return json(res, 400, { message: "OTP passkey salah. Cek lagi Telegram kamu." });
  }

  const codes = generatePasskeyCodes(3);
  const inactiveReplyMarkup = createPasskeyReplyMarkup(user, currentEntry.websiteUrl || "");
  passkeyStore[user] = {
    ...currentEntry,
    user,
    codes,
    updatedAt: Date.now(),
    pendingOtp: null
  };
  await writePasskeyStore(passkeyStore);
  if (currentEntry.pendingOtp?.chatId && currentEntry.pendingOtp?.messageId) {
    await callTelegramApi("editMessageText", {
      chat_id: String(currentEntry.pendingOtp.chatId),
      message_id: Number(currentEntry.pendingOtp.messageId),
      parse_mode: "HTML",
      text: createPasskeyInactiveText(),
      ...(inactiveReplyMarkup ? { reply_markup: inactiveReplyMarkup } : {})
    }).catch(() => {});
  }
  appendConsoleLog(store, "success", `[${user}] Update passkey (${codes.length} kode baru)`);
  await writeStore(store);
  return json(res, 200, {
    message: "Passkey berhasil diperbarui.",
    passkey: getPasskeyPayload(passkeyStore, user)
  });
}

async function handleClearEvent(body, res) {
  const { user, eventId, sessionToken } = body;
  if (!user || !eventId || !sessionToken) {
    return json(res, 400, { message: "User, eventId, dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }
  store.events[user] = (store.events[user] || []).filter((event) => event.id !== eventId);
  if (!store.events[user].length) {
    delete store.events[user];
  }
  await writeStore(store);
  return json(res, 200, { message: "Notif dihapus." });
}

async function handleLogout(body, res, req) {
  const { user, sessionToken } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi untuk logout." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid untuk logout." });
  }
  const regRecord = findLatestUserEntry(store.reg, (value) => value.user === user);

  if (!regRecord) {
    return json(res, 404, { message: "User tidak ditemukan untuk logout." });
  }

  const { dateKey: regDateKey, timeKey: regTimeKey, username: regUsername, value: regValue } = regRecord;
  store.reg[regDateKey][regTimeKey][regUsername] = {
    ...regValue,
    trusted: "no",
    trusted_ip: "",
    trusted_token: "",
    active_session_token: ""
  };

  appendConsoleLog(store, "info", `Logout: ${user}`);

  await writeStore(store);

  return json(res, 200, {
    message: "Logout berhasil. Perangkat terpercaya sudah direset."
  });
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (await tryServeStaticFile(parsedUrl, res)) {
      return;
    }

    if (req.method === "GET") {
      const adminRoute = parseAdminRoute(parsedUrl);
      if (adminRoute) {
        const html = await fs.readFile(adminRoute.filePath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
    }

    if (req.method === "GET" && parsedUrl.pathname === "/") {
      const html = await fs.readFile(INDEX_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/register") {
      return handleRegister(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/register/test-send") {
      return handleTestSend(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/telegram/link-status") {
      return handleTelegramLinkStatus(await parseBody(req), res, req);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/register/verify") {
      return handleVerifyRegister(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/login") {
      return handleLogin(await parseBody(req), res, req);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/login/verify") {
      return handleVerifyLogin(await parseBody(req), res, req);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/session/auto") {
      return handleAutoSession(await parseBody(req), res, req);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/logout") {
      return handleLogout(await parseBody(req), res, req);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/profile") {
      return handleProfile(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/theme-config") {
      return handleThemeConfig(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/theme-config/save") {
      return handleThemeConfigSave(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/profile/public") {
      return handlePublicProfile(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/list") {
      return handlePostList(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/detail") {
      return handlePostDetail(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/create") {
      return handlePostCreate(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/action") {
      return handlePostAction(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/comment") {
      return handlePostComment(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/comment/update") {
      return handlePostCommentUpdate(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/comment/delete") {
      return handlePostCommentDelete(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/update") {
      return handlePostUpdate(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/post/delete") {
      return handlePostDelete(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/profile/update") {
      return handleProfileUpdate(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/profile/media") {
      return handleProfileMediaUpdate(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/passkey/status") {
      return handlePasskeyStatus(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/passkey/generate") {
      return handlePasskeyGenerate(await parseBody(req), res, req);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/admin/add-user") {
      return handleAdminAddUser(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/admin/action") {
      return handleAdminAction(await parseBody(req), res);
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/admin/console") {
      return handleConsoleLogs(res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/admin/console/command") {
      return handleConsoleCommand(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/admin/files") {
      return await handleFileManager(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/admin/file-preview") {
      return await handleFilePreview(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/events/clear") {
      return handleClearEvent(await parseBody(req), res);
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/dashboard") {
      return handleDashboard(res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/search") {
      return handleSearch(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/search/public") {
      return handlePublicSearch(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/session/status") {
      return handleSessionStatus(await parseBody(req), res);
    }

    return json(res, 404, { message: "Route tidak ditemukan." });
  } catch (error) {
    return json(res, 500, { message: `Server error: ${error.message}` });
  }
}

module.exports = {
  handleRequest
};

if (require.main === module) {
  const server = http.createServer(handleRequest);
  ensureStore()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error("Gagal menyiapkan data store:", error);
      process.exit(1);
    });
}
