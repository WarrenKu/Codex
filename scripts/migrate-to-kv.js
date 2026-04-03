const fs = require("fs/promises");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "otp-store.json");
const KV_REST_API_URL = process.env.KV_REST_API_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "";
const KV_STORE_KEY = process.env.KV_STORE_KEY || "otp-store";

async function kvSet(value) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    throw new Error("KV_REST_API_URL atau KV_REST_API_TOKEN belum diisi.");
  }

  const response = await fetch(KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(["SET", KV_STORE_KEY, value])
  });

  if (!response.ok) {
    throw new Error(`KV request gagal (${response.status}).`);
  }

  const result = await response.json();
  if (result?.error) {
    throw new Error(result.error);
  }
}

async function main() {
  const raw = await fs.readFile(DATA_FILE, "utf8");
  if (!raw.trim()) {
    throw new Error("File otp-store.json kosong.");
  }

  JSON.parse(raw);
  await kvSet(raw);
  console.log(`Migrasi berhasil ke KV key "${KV_STORE_KEY}".`);
}

main().catch((error) => {
  console.error("Migrasi gagal:", error.message);
  process.exit(1);
});
