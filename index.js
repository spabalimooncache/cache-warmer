import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

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

const MOBILE_USER_AGENTS = {
  android: "SpaBAliMoon-CacheWarmer-Android/1.0",
  ios: "SpaBAliMoon-CacheWarmer-iOS/1.0",
};

const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getProxyAgent(country) {
  const proxy = PROXIES[country];
  if (!proxy) throw new Error(`Missing proxy for ${country}`);
  return new HttpsProxyAgent(proxy);
}

function getUserAgent(country, isMobile = false, platform = "android") {
  if (isMobile) {
    return MOBILE_USER_AGENTS[platform] || MOBILE_USER_AGENTS.android;
  }
  return USER_AGENTS[country] || "CacheWarmer/1.0";
}

async function fetchWithProxy(url, country) {
  const agent = getProxyAgent(country);
  const res = await axios.get(url, {
    httpsAgent: agent,
    headers: { "User-Agent": getUserAgent(country) },
    timeout: 15000,
  });
  return res.data;
}

async function fetchIndexSitemaps(domain, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap_index.xml`, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const sitemapList = result?.sitemapindex?.sitemap;
    if (!sitemapList) return [];
    const sitemaps = Array.isArray(sitemapList) ? sitemapList : [sitemapList];
    return sitemaps.map((entry) => entry.loc);
  } catch (err) {
    console.warn(`[${country}] ❌ Failed to fetch sitemap index: ${err?.message}`);
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urlList = result?.urlset?.url;
    if (!urlList) return [];
    const urls = Array.isArray(urlList) ? urlList : [urlList];
    return urls.map((entry) => entry.loc);
  } catch (err) {
    console.warn(`[${country}] ❌ Failed to fetch URLs from ${sitemapUrl}: ${err?.message}`);
    return [];
  }
}

async function retryableGet(url, config, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      lastError = err;
      const isRetryable = axios.isAxiosError(err) && ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(err.code);
      if (!isRetryable) break;
      await sleep(2000);
    }
  }
  throw lastError;
}

async function purgeCloudflareCache(url) {
  try {
    const purgeRes = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
      { files: [url] },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (purgeRes.data.success) {
      console.log(`✅ Cloudflare cache purged: ${url}`);
    } else {
      console.warn(`⚠️ Failed to purge Cloudflare: ${url}`);
    }
  } catch (err) {
    console.warn(`❌ Error purging Cloudflare: ${url}`);
  }
}

async function warmUrls(
  urls,
  country,
  delay = 5000,
  isMobile = false,
  platform = ""
) {
  const agent = getProxyAgent(country);
  const userAgent = getUserAgent(country, isMobile, platform);
  const mode = isMobile
    ? `MOBILE-${(platform || "android").toUpperCase()}`
    : "DESKTOP";


  console.log(`[DEBUG UA] ${mode} - UA: ${userAgent}`);

  for (const url of urls) {
    try {
      const res = await retryableGet(url, {
        httpsAgent: agent,
        headers: { "User-Agent": userAgent },
        timeout: 15000,
      });

      const cfCache = res.headers["cf-cache-status"] || "N/A";
      const lsCache = res.headers["x-litespeed-cache"] || "N/A";
      const cfRay = res.headers["cf-ray"] || "N/A";
      const cfEdge = cfRay.includes("-") ? cfRay.split("-")[1] : "N/A";

      console.log(
        `[${country}][${mode}] ${res.status} cf=${cfCache} ls=${lsCache} edge=${cfEdge} - ${url}`
      );

      if (lsCache.toLowerCase() !== "hit") {
        await purgeCloudflareCache(url);
      }
    } catch (err) {
      console.warn(
        `[${country}][${mode}] ❌ Failed to warm ${url}: ${err?.message}`
      );
    }

    await sleep(delay); // Delay antar URL
  }
}


// 🚀 MAIN
(async () => {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);

  for (const [country, domain] of Object.entries(DOMAINS_MAP)) {
    if (!PROXIES[country]) {
      console.warn(`[${country}] ❌ Skipping: no proxy defined`);
      continue;
    }

    console.log(`🌐 [${country}] Processing ${domain}...`);

    const sitemapList = await fetchIndexSitemaps(domain, country);
    const urlArrays = await Promise.all(
      sitemapList.map((sitemapUrl) => fetchUrlsFromSitemap(sitemapUrl, country))
    );
    const urls = urlArrays.flat().filter(Boolean);

    console.log(`[${country}] Found ${urls.length} URLs`);

    // Warming for MOBILE - IOS
    await warmUrls(urls, country, 1000, true, "ios");

    // Warming for MOBILE - ANDROID
    await warmUrls(urls, country, 1000, true, "android");

    // Warming for DESKTOP
    await warmUrls(urls, country, 1000, false);

    console.log(`[${country}] ✅ Finished\n`);
  }

  console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
})();

