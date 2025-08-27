import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ====== ENV WAJIB ====== */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // URL Web App GAS /exec

/* ====== KONFIG DOMAIN/PROXY/UA ====== */
const DOMAINS_MAP = {
  id: "https://spabalimoon.com",
  tw: "https://spabalimoon.com",
  au: "https://spabalimoon.com",
  nl: "https://spabalimoon.com",
  no: "https://spabalimoon.com",
  dk: "https://spabalimoon.com",
  de: "https://spabalimoon.com",
  fr: "https://spabalimoon.com",
  en: "https://spabalimoon.com",
  es: "https://spabalimoon.com",
  se: "https://spabalimoon.com",
  fl: "https://spabalimoon.com",
};

const PROXIES = {
  id: process.env.BRD_PROXY_ID,
  tw: process.env.BRD_PROXY_TW,
  au: process.env.BRD_PROXY_AU,
  nl: process.env.BRD_PROXY_NL,
  no: process.env.BRD_PROXY_NO,
  dk: process.env.BRD_PROXY_DK,
  de: process.env.BRD_PROXY_DE,
  fr: process.env.BRD_PROXY_FR,
  en: process.env.BRD_PROXY_EN,
  es: process.env.BRD_PROXY_ES,
  se: process.env.BRD_PROXY_SE,
  fl: process.env.BRD_PROXY_FL,
};

// === 1 USER AGENT PER COUNTRY (DESKTOP ONLY) ===
const USER_AGENTS = {
  id: "SpaBaliMoon-CacheWarmer-ID/1.0",
  tw: "SpaBaliMoon-CacheWarmer-TW/1.0",
  au: "SpaBaliMoon-CacheWarmer-AU/1.0",
  nl: "SpaBaliMoon-CacheWarmer-NL/1.0",
  no: "SpaBaliMoon-CacheWarmer-NO/1.0",
  dk: "SpaBaliMoon-CacheWarmer-DK/1.0",
  de: "SpaBaliMoon-CacheWarmer-DE/1.0",
  fr: "SpaBaliMoon-CacheWarmer-FR/1.0",
  en: "SpaBaliMoon-CacheWarmer-EN/1.0",
  es: "SpaBaliMoon-CacheWarmer-ES/1.0",
  se: "SpaBaliMoon-CacheWarmer-SE/1.0",
  fl: "SpaBaliMoon-CacheWarmer-FL/1.0",
};

/* ====== CLOUDFLARE (opsional) ====== */
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Nama tab per-run: YYYY-MM-DD_HH-mm-ss_WITA */
function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000); // WITA +08
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER → APPS SCRIPT (BATCH PER-RUN) ====== */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun(); // satu tab per-run
  }

  log({
    country = "",
    mode = "",
    url = "",
    status = "",
    cfCache = "",
    lsCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId, // run_id
      this.startedAt, // started_at (ISO)
      this.finishedAt, // finished_at (diisi saat finalize)
      country, // country
      mode, // device/mode (tetap disimpan, di sini fixed "DESKTOP")
      url, // url
      status, // status code
      cfCache, // cf_cache
      lsCache, // litespeed_cache
      cfRay, // cf_ray
      typeof responseMs === "number" ? responseMs : "", // response_ms
      error ? 1 : 0, // error (0/1)
      message, // message
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL) {
      console.warn("Apps Script logging disabled (missing APPS_SCRIPT_URL).");
      return;
    }
    if (this.rows.length === 0) return;

    try {
      const res = await axios.post(
        APPS_SCRIPT_URL,
        { sheetName: this.sheetName, rows: this.rows },
        { timeout: 20000, headers: { "Content-Type": "application/json" } }
      );
      console.log("Apps Script response:", res.status, res.data);
      if (!res.data?.ok) console.warn("Apps Script replied error:", res.data);
      this.rows = []; // bersihkan buffer
    } catch (e) {
      console.warn(
        "Apps Script logging error:",
        e?.response?.status,
        e?.response?.data || e?.message || e
      );
    }
  }
}

/* ====== HTTP helper (dgn/tnp proxy) ====== */
function buildAxiosCfg(country, extra = {}) {
  const proxy = PROXIES[country];
  const headers = {
    "User-Agent": USER_AGENTS[country] || "CacheWarmer/1.0",
  };
  const cfg = {
    headers,
    timeout: 30000,
    validateStatus: () => true, // biar bisa baca header meski 4xx/5xx
    ...extra,
  };
  if (proxy) cfg.httpsAgent = new HttpsProxyAgent(proxy);
  return cfg;
}

async function fetchWithProxy(url, country, timeout = 20000) {
  const cfg = buildAxiosCfg(country, { timeout });
  const res = await axios.get(url, cfg);
  return res.data;
}

/* ====== SITEMAP ====== */
async function fetchIndexSitemaps(domain, country) {
  try {
    const xml = await fetchWithProxy(
      `${domain}/sitemap_index.xml`,
      country,
      20000
    );
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const sitemapList = result?.sitemapindex?.sitemap;
    if (!sitemapList) return [];
    const sitemaps = Array.isArray(sitemapList) ? sitemapList : [sitemapList];
    return sitemaps.map((entry) => entry.loc).filter(Boolean);
  } catch (err) {
    console.warn(
      `[${country}] ❌ Failed to fetch sitemap index: ${err?.message || err}`
    );
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country, 20000);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const urlList = result?.urlset?.url;
    if (!urlList) return [];
    const urls = Array.isArray(urlList) ? urlList : [urlList];
    return urls.map((entry) => entry.loc).filter(Boolean);
  } catch (err) {
    console.warn(
      `[${country}] ❌ Failed to fetch URLs from ${sitemapUrl}: ${
        err?.message || err
      }`
    );
  }
  return [];
}

/* ====== HELPERS: URL GUARDS ====== */
function sameHostOnly(urls, baseDomain) {
  const base = new URL(baseDomain);
  return urls.filter((u) => {
    try {
      const x = new URL(u);
      return x.host === base.host;
    } catch {
      return false;
    }
  });
}

function dedup(arr) {
  return Array.from(new Set(arr));
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function filterSkips(urls) {
  const skipExt = /\.(pdf|zip|rar|7z|png|jpe?g|gif|webp|svg|mp4|mp3|webm)$/i;
  return urls.filter((u) => !skipExt.test(u) && !u.includes("?amp"));
}

/* ====== RETRY + BACKOFF ====== */
async function retryableGet(url, cfg, retries = 3) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const res = await axios.get(url, cfg);
      return res;
    } catch (err) {
      lastErr = err;
      const code = err?.code || "";
      const status = err?.response?.status;
      const retryableNetwork = [
        "ECONNABORTED",
        "ECONNRESET",
        "ETIMEDOUT",
      ].includes(code);
      const retryableHttp = status >= 500 || status === 429;
      if (attempt === retries || (!retryableNetwork && !retryableHttp)) break;
      const backoff =
        Math.min(2000 * Math.pow(2, attempt), 10000) + rand(0, 300);
      await sleep(backoff);
      attempt++;
    }
  }
  throw lastErr;
}

/* ====== CLOUDFLARE PURGE (BATCH) ====== */
async function purgeCloudflareBatch(urls) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;

  const chunks = [];
  const BATCH = 30;
  for (let i = 0; i < urls.length; i += BATCH) {
    chunks.push(urls.slice(i, i + BATCH));
  }

  for (const chunk of chunks) {
    try {
      const purgeRes = await axios.post(
        `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
        { files: chunk },
        {
          headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          timeout: 20000,
        }
      );
      if (purgeRes.data?.success) {
        console.log(`✅ Cloudflare purged ${chunk.length} URL`);
      } else {
        console.warn(`⚠️ CF purge error:`, purgeRes.data);
      }
    } catch (err) {
      console.warn(`❌ CF purge request failed:`, err?.message || err);
    }
    await sleep(500);
  }
}

/* ====== WARMING (POOL CONCURRENCY) — DESKTOP ONLY ====== */
async function warmUrlsPool({
  urls,
  country,
  concurrency = 6,
  requestTimeout = 15000,
  logger,
}) {
  console.log(
    `[${country}] warming ${urls.length} URLs with concurrency=${concurrency}`
  );

  const needPurge = new Set();
  let idx = 0;

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= urls.length) break;
      const url = urls[i];
      const t0 = Date.now();
      try {
        const cfg = buildAxiosCfg(country, { timeout: requestTimeout });
        const res = await retryableGet(url, cfg, 3);
        const dt = Date.now() - t0;

        const cfCache = res.headers?.["cf-cache-status"] || "N/A";
        const lsCache = res.headers?.["x-litespeed-cache"] || "N/A";
        const cfRay = res.headers?.["cf-ray"] || "N/A";
        const edge =
          typeof cfRay === "string" && cfRay.includes("-")
            ? cfRay.split("-")[1]
            : "N/A";

        console.log(
          `[${country}] ${res.status} cf=${cfCache} ls=${lsCache} edge=${edge} - ${url}`
        );

        logger.log({
          country,
          url,
          status: res.status,
          cfCache,
          lsCache,
          cfRay,
          responseMs: dt,
          error: 0,
          message: "",
        });

        if (String(lsCache).toLowerCase() !== "hit") {
          needPurge.add(url);
        }
      } catch (err) {
        const dt = Date.now() - t0;
        console.warn(
          `[${country}] ❌ ${url} -> ${err?.message || err}`
        );
        logger.log({
          country,
          url,
          responseMs: dt,
          error: 1,
          message: err?.message || "request failed",
        });
      }
      await sleep(100);
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  if (needPurge.size > 0) {
    console.log(
      `[${country}] CF purge ${needPurge.size} URL (batched)`
    );
    await purgeCloudflareBatch(Array.from(needPurge));
  } else {
    console.log(`[${country}] CF purge skipped (all HIT)`);
  }
}

/* ====== MAIN ====== */
(async () => {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  const stop = async () => {
    logger.setFinished();
    await logger.flush();
    console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
  };

  process.on("SIGINT", async () => {
    console.log("SIGINT caught. Flushing logs…");
    await stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    console.log("SIGTERM caught. Flushing logs…");
    await stop();
    process.exit(0);
  });

  try {
    for (const [country, domain] of Object.entries(DOMAINS_MAP)) {
      if (!PROXIES[country]) {
        console.warn(`[${country}] ❌ Skipping: no proxy defined`);
        continue;
      }

      console.log(`🌐 [${country}] Processing ${domain}…`);
      const sitemapList = await fetchIndexSitemaps(domain, country);

      const urlArrays = await Promise.all(
        sitemapList.map((sitemapUrl) =>
          fetchUrlsFromSitemap(sitemapUrl, country)
        )
      );
      let urls = urlArrays.flat().filter(Boolean) || [];

      urls = sameHostOnly(urls, domain);
      urls = filterSkips(urls);
      urls = dedup(urls);
      shuffle(urls);

      const MAX_PER_COUNTRY = 5000;
      if (urls.length > MAX_PER_COUNTRY) {
        console.log(
          `[${country}] Trimming ${urls.length} → ${MAX_PER_COUNTRY}`
        );
        urls = urls.slice(0, MAX_PER_COUNTRY);
      }

      console.log(`[${country}] Found ${urls.length} URLs after filtering`);
      logger.log({
        country,
        url: domain,
        message: `Found ${urls.length} URLs`,
      });

      // === DESKTOP ONLY RUN ===
      await warmUrlsPool({
        urls,
        country,
        concurrency: 6,
        requestTimeout: 15000,
        logger,
      });

      console.log(`[${country}] ✅ Finished\n`);
    }
  } finally {
    await (async () => {
      logger.setFinished();
      await logger.flush();
      console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
    })();
  }
})();
