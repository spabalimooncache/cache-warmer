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
};

const PROXIES = {
  id: process.env.BRD_PROXY_ID,
};

const USER_AGENTS = {
  id: "SpaBaliMoon-CacheWarmer-ID/1.0",
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
    url = "",
    status = "",
    cfCache = "",
    originCache = "",
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
      url, // url
      status, // status code
      cfCache, // cf_cache
      originCache, // vercel_cache
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
        { timeout: 120000, headers: { "Content-Type": "application/json" } }
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
    ...extra,
  };
  if (proxy) cfg.httpsAgent = new HttpsProxyAgent(proxy);
  return cfg;
}

function buildRevalidationAxiosCfg(country) {
  const cfg = buildAxiosCfg(country, { timeout: 15000 });
  cfg.headers = {
    ...cfg.headers,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
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
    const xml = await fetchWithProxy(`${domain}/sitemap.xml`, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const sitemapList = result?.sitemapindex?.sitemap;
    if (sitemapList) {
      return {
        sitemaps: (Array.isArray(sitemapList) ? sitemapList : [sitemapList])
          .map((e) => e.loc)
          .filter(Boolean),
        urls: [],
      };
    }

    // Some sites redirect /sitemap.xml to a sitemap containing URLs
    // directly instead of a sitemap index containing child sitemap files.
    const urlList = result?.urlset?.url;
    if (urlList) {
      return {
        sitemaps: [],
        urls: (Array.isArray(urlList) ? urlList : [urlList])
          .map((e) => e.loc)
          .filter(Boolean),
      };
    }

    console.warn(`[${country}] Sitemap response has no <sitemapindex> or <urlset>`);
    return { sitemaps: [], urls: [] };
  } catch (err) {
    console.warn(
      `[${country}] Failed to fetch sitemap index: ${err?.message || err}`
    );
    return { sitemaps: [], urls: [] };
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
      `[${country}] ❌ Failed to fetch URLs from ${sitemapUrl}: ${err?.message || err
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
  shouldStop = () => false,
}) {
  console.log(
    `[${country}] warming ${urls.length} URLs with concurrency=${concurrency}`
  );

  const needPurge = new Set();
  let idx = 0;

  const worker = async () => {
    while (!shouldStop()) {
      const i = idx++;
      if (i >= urls.length) break;
      const url = urls[i];
      const t0 = Date.now();
      try {
        const cfg = buildAxiosCfg(country, { timeout: requestTimeout });
        let res = await retryableGet(url, cfg, 3);
        let originCache = res.headers?.["x-vercel-cache"] || "N/A";

        if (String(originCache).toLowerCase() === "stale") {
          console.log(
            `[${country}] Cached response reports STALE; purging Cloudflare and requesting revalidation: ${url}`
          );
          await purgeCloudflareBatch([url]);
          try {
            res = await retryableGet(url, buildRevalidationAxiosCfg(country), 0);
            originCache = res.headers?.["x-vercel-cache"] || "N/A";
          } catch (revalidationError) {
            console.warn(
              `[${country}] Revalidation failed for ${url}: ${revalidationError?.message || revalidationError}`
            );
          }
        }

        const dt = Date.now() - t0;

        const cfCache = res.headers?.["cf-cache-status"] || "N/A";
        const cfRay = res.headers?.["cf-ray"] || "N/A";
        const edge =
          typeof cfRay === "string" && cfRay.includes("-")
            ? cfRay.split("-")[1]
            : "N/A";

        console.log(
          `[${country}] ${res.status} cf=${cfCache} vercel=${originCache} edge=${edge} - ${url}`
        );

        logger.log({
          country: edge,
          url,
          status: res.status,
          cfCache,
          originCache,
          cfRay,
          responseMs: dt,
          error: 0,
          message: "",
        });

        const originStatus = String(originCache).toLowerCase();
        if (originStatus === "stale" && String(cfCache).toLowerCase() === "hit") {
          console.warn(
            `[${country}] Cloudflare served a cached STALE response; Vercel revalidation was not confirmed for ${url}`
          );
        }
        if (
          originCache !== "N/A" &&
          originStatus !== "hit"
        ) {
          needPurge.add(url);
          console.log(`[${country}] Queued Cloudflare purge (${originCache}): ${url}`);
        }
      } catch (err) {
        const dt = Date.now() - t0;
        console.warn(`[${country}] ❌ ${url} -> ${err?.message || err}`);

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
    console.log(`[${country}] CF purge ${needPurge.size} URL (batched)`);
    await purgeCloudflareBatch(Array.from(needPurge));
  } else {
    console.log(`[${country}] CF purge skipped (no origin cache status requires purging)`);
  }
}

/* ====== MAIN ====== */
(async () => {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  let stopping = false;
  const requestStop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(
      `${signal} caught. Stopping new URLs; waiting for in-flight requests and pending Cloudflare purge…`
    );
  };
  const onSigint = () => requestStop("SIGINT");
  const onSigterm = () => requestStop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    for (const [country, domain] of Object.entries(DOMAINS_MAP)) {
      if (stopping) break;
      if (!PROXIES[country]) {
        console.warn(`[${country}] ❌ Skipping: no proxy defined`);
        continue;
      }

      console.log(`🌐 [${country}] Processing ${domain}…`);
      const { sitemaps: sitemapList, urls: directUrls } =
        await fetchIndexSitemaps(domain, country);
      if (stopping) break;

      const urlArrays = await Promise.all(
        sitemapList.map((sitemapUrl) =>
          fetchUrlsFromSitemap(sitemapUrl, country)
        )
      );
      if (stopping) break;
      let urls = [...directUrls, ...urlArrays.flat()].filter(Boolean);

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
        shouldStop: () => stopping,
      });

      console.log(`[${country}] ✅ Finished\n`);
    }
  } finally {
    try {
      logger.setFinished();
      await logger.flush();
      console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
})();
