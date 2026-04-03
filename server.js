const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8322599942:AAGa4i5WGRvv4SuzeyUVG6tJyAK-b576R2Y";
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "";
const TELEGRAM_BOT_ID = process.env.TELEGRAM_BOT_ID || "";
const KV_REST_API_URL = process.env.KV_REST_API_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "";
const KV_STORE_KEY = process.env.KV_STORE_KEY || "otp-store";
const INDEX_FILE = path.join(__dirname, "index.html");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "otp-store.json");
const DATA_FILE_BAK = path.join(DATA_DIR, "otp-store.json.bak");
const EMPTY_STORE = {
  reg: {},
  log: {},
  "log-otp": {},
  telegramLinks: {},
  events: {},
  consoleLogs: []
};
let writeQueue = Promise.resolve();

function useRemoteStore() {
  return !!(KV_REST_API_URL && KV_REST_API_TOKEN);
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

function normalizeStore(store) {
  return {
    reg: store.reg || {},
    log: store.log || {},
    "log-otp": store["log-otp"] || {},
    telegramLinks: store.telegramLinks || {},
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

function validateUsername(user) {
  const value = String(user || "").trim();
  if (value.length < 2 || value.length > 10) {
    return "Username harus 2 sampai 10 karakter.";
  }
  if (!/^[A-Za-z0-9#._-]+$/.test(value)) {
    return "Username hanya boleh huruf, angka, #, titik, underscore, dan strip.";
  }
  return "";
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 2 || value.length > 8) {
    return "Password harus 2 sampai 8 karakter.";
  }
  return "";
}

function createSessionToken() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 18)}`;
}

async function readStore() {
  if (useRemoteStore()) {
    const result = await kvCommand(["GET", KV_STORE_KEY]);
    const raw = typeof result?.result === "string" ? result.result : "";
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
      await kvCommand(["SET", KV_STORE_KEY, JSON.stringify(store)]);
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

function getProfilePayload(store, user) {
  const entry = findLatestUserEntry(store.reg, (value) => value.user === user && value.status === "success");
  if (!entry) {
    return null;
  }

  const value = entry.value;
  const teleRaw = String(value.tele || "").trim();
  const teleUsername = teleRaw.startsWith("@") ? teleRaw : "";
  return {
    user: value.user,
    displayName: value.display_name || value.user,
    bio: value.bio || "Belum ada deskripsi user.",
    registeredAt: `${entry.dateKey} ${entry.timeKey.replaceAll("-", ":")}`,
    telegram: teleRaw,
    telegramUsername: teleUsername,
    role: value.role || "visitor",
    previousUsers: Array.isArray(value.previous_users) ? value.previous_users : [],
    pass: value.pass || ""
  };
}

function getPublicProfilePayload(store, user) {
  const entry = findLatestUserEntry(store.reg, (value) => value.user === user && value.status === "success");
  if (!entry) {
    return null;
  }

  const value = entry.value;
  return {
    id: `user-${value.user}`,
    type: "user",
    user: value.user,
    displayName: value.display_name || value.user,
    bio: value.bio || "Belum ada deskripsi user.",
    registeredAt: `${entry.dateKey} ${entry.timeKey.replaceAll("-", ":")}`,
    role: value.role || "visitor",
    status: getStatusFromValue(value),
    online: isUserOnline(value)
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

  const users = Array.from(latestUserMap.values()).map((entry) => {
    const value = entry.value;
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
      tele: value.tele || ""
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
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(chatIdOrUsername).trim(),
      text
    })
  });

  return response.json();
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
        body: JSON.stringify(payload)
      }
    : { method: "GET" };
  const response = await fetch(apiUrl, options);
  return response.json();
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

async function getTelegramUpdates() {
  return callTelegramApi("getUpdates");
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

function describeTelegramFailure(target, description = "") {
  const normalizedTarget = normalizeTelegramTarget(target);
  const rawDescription = String(description || "Tidak ada detail error.");
  if (normalizedTarget.startsWith("@") && /chat not found/i.test(rawDescription)) {
    return `${rawDescription}. Username Telegram hanya bisa dipakai kalau user tersebut sudah pernah chat / start ke bot. Kalau belum, pakai ID Telegram lebih aman.`;
  }
  return rawDescription;
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
  store.telegramLinks[token] = {
    token,
    type: config.type || "register",
    user: config.user || "",
    password: config.password || "",
    telegramTarget: normalizeTelegramTarget(config.telegramTarget || ""),
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
    startUrl: plainUsername ? `https://t.me/${plainUsername}?start=${token}` : "",
    message: "Bot belum mendeteksi chat kamu. Buka bot dulu lalu tekan Confirm supaya sistem cek /start dan kirim OTP otomatis."
  };
}

async function resolveTelegramHandshake(store, token) {
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
    return payload === token;
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

async function handleTelegramLinkStatus(body, res) {
  const { token } = body;
  if (!token) {
    return json(res, 400, { message: "Token Telegram wajib diisi." });
  }

  const store = await readStore();
  const result = await resolveTelegramHandshake(store, String(token).trim());
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
    (value) => value.user === user && value.pass === password
  );

  if (!otpRecord) {
    return json(res, 404, { message: "Data OTP login tidak ditemukan. Ulangi login dulu." });
  }

  const { dateKey, timeKey, username, value: otpValue } = otpRecord;

  if (otpValue.otprial !== otp) {
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

  return {
    totalUsers: users.filter((user) => user.status !== "deleted").length,
    roleCounts: Object.fromEntries(Object.entries(roleGroups).map(([role, items]) => [role, items.length])),
    roles: roleGroups,
    chart
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
  const { command, actor } = body;
  const store = await readStore();
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

async function handleSessionStatus(body, res) {
  const { user, sessionToken } = body;
  if (!user || !sessionToken) {
    return json(res, 400, { message: "User dan session token wajib diisi." });
  }

  const store = await readStore();
  if (!hasValidSession(store, user, sessionToken)) {
    return json(res, 403, { message: "Session tidak valid." });
  }

  const changed = clearExpiredEvents(store, user);
  const regRecord = findLatestUserEntry(store.reg, (value) => value.user === user);
  const state = getUserAccountState(regRecord);
  if (changed) {
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

  const profile = getProfilePayload(store, user);
  if (!profile) {
    return json(res, 404, { message: "Profil user tidak ditemukan." });
  }

  return json(res, 200, { profile });
}

async function handlePublicProfile(body, res) {
  const { targetUser } = body;
  if (!targetUser) {
    return json(res, 400, { message: "Target user wajib diisi." });
  }
  const store = await readStore();
  const profile = getPublicProfilePayload(store, String(targetUser).trim());
  if (!profile) {
    return json(res, 404, { message: "Profil user tidak ditemukan." });
  }

  return json(res, 200, { profile });
}

async function handleProfileUpdate(body, res) {
  const { user, sessionToken, field, value } = body;
  if (!user || !sessionToken || !field) {
    return json(res, 400, { message: "User, session token, dan field wajib diisi." });
  }

  const store = await readStore();
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
    if (!trimmedValue) {
      return json(res, 400, { message: "Nama panggilan tidak boleh kosong." });
    }
    updateAllUserEntries(store.reg, user, (item) => ({
      ...item,
      display_name: trimmedValue
    }));
    appendConsoleLog(store, "info", `[${user}] Update display name -> ${trimmedValue}`);
    await writeStore(store);
    return json(res, 200, {
      message: "Nama panggilan berhasil diperbarui.",
      profile: getProfilePayload(store, user)
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
      profile: getProfilePayload(store, user)
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
      profile: getProfilePayload(store, user)
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
    return json(res, 200, {
      message: "Username berhasil diperbarui.",
      profile: getProfilePayload(store, trimmedValue),
      nextUser: trimmedValue
    });
  }

  return json(res, 400, { message: "Field profil tidak dikenali." });
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
      return handleTelegramLinkStatus(await parseBody(req), res);
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

    if (req.method === "POST" && parsedUrl.pathname === "/api/profile/public") {
      return handlePublicProfile(await parseBody(req), res);
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/profile/update") {
      return handleProfileUpdate(await parseBody(req), res);
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
