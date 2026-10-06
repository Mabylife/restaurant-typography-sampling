//   node fetch_candidates.mjs                                  六都查詢 → candidates.csv
//   node fetch_candidates.mjs --only "臺中市 美式餐廳"          只跑單一組合（試跑）
//   node fetch_candidates.mjs --near 24.1477,120.6736 [--radius 800]
//                                                              指定座標周邊查詢 → candidates_a.csv

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.primaryTypeDisplayName",
  "places.userRatingCount",
  "places.rating",
  "places.businessStatus",
  "places.googleMapsUri",
  "nextPageToken",
].join(",");
// --near 需要店家座標才能計算距離
const NEAR_FIELD_MASK = `${FIELD_MASK},places.location`;

const CITIES = ["臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市"];

// [關鍵字, 子類型]
const KEYWORDS = [
  ["美式餐廳", "美式餐廳/餐酒館"],
  ["美式餐酒館", "美式餐廳/餐酒館"],
  ["美式牛排", "牛排"],
  ["美式漢堡", "漢堡"],
  ["美式早午餐", "早午餐"],
  ["美式BBQ", "BBQ"],
  ["墨西哥", "墨西哥"],
  ["美式酒吧", "酒吧"],
];

const REGIONS = {
  北: ["臺北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "宜蘭縣"],
  中: ["苗栗縣", "臺中市", "彰化縣", "南投縣", "雲林縣"],
  南: ["嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣"],
};

const MAX_PAGES = 3;
const CALL_LIMIT = 200;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const RAW_DIR = "raw";
const OUTPUT_FILE = "candidates.csv";
const NEAR_OUTPUT_FILE = "candidates_a.csv";
const DEFAULT_RADIUS_M = 800;
const METERS_PER_DEGREE_LAT = 111320;
const EARTH_RADIUS_M = 6371000;

const DISTANCE_COLUMN = "直線距離（公尺）";
const CSV_HEADER = [
  "店名",
  "子類型",
  "評論數",
  "評分",
  "縣市",
  "區域",
  "Google類型",
  "地址",
  "地圖連結",
  "搜尋來源",
  "place_id",
  "擷取時間",
  "判定",
  "實際子類型",
  "品牌",
  "連鎖",
  "選入輪次",
  "排除理由",
];

class CallLimitError extends Error {}

let callCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

const KNOWN_FLAGS = ["--only", "--near", "--radius"];

// 未知參數直接結束，避免打錯字時誤跑完整查詢。
function checkArgs(argv) {
  for (let i = 0; i < argv.length; i += 2) {
    if (!KNOWN_FLAGS.includes(argv[i])) {
      exitWithError(`無法辨識的參數：「${argv[i]}」。可用參數：${KNOWN_FLAGS.join("、")}`);
    }
  }
}

// 回傳旗標的值；沒有這個旗標時回傳 undefined，有旗標但沒給值時直接結束。
function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) exitWithError(`${name} 需要一個值。`);
  return value;
}

function parseNear(argv) {
  const nearValue = flagValue(argv, "--near");
  const radiusValue = flagValue(argv, "--radius");
  if (nearValue === undefined) {
    if (radiusValue !== undefined) exitWithError("--radius 只能搭配 --near 使用。");
    return null;
  }

  const parts = nearValue.split(",").map((s) => s.trim());
  const [lat, lng] = parts.map(Number);
  if (parts.length !== 2 || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    exitWithError(`--near 的值無效：「${nearValue}」，格式須為「<緯度>,<經度>」，例如 24.1477,120.6736`);
  }

  const radius = radiusValue === undefined ? DEFAULT_RADIUS_M : Number(radiusValue);
  if (!Number.isFinite(radius) || radius <= 0) {
    exitWithError(`--radius 的值無效：「${radiusValue}」，須為正數（公尺）。`);
  }
  return { lat, lng, radius };
}

function buildQueries(argv, near) {
  if (near) {
    if (argv.includes("--only")) exitWithError("--only 不能與 --near 同時使用。");
    return KEYWORDS.map(([keyword, subtype]) => ({
      textQuery: keyword,
      rawPrefix: `near_${keyword}`,
      subtype,
    }));
  }

  const all = CITIES.flatMap((city) =>
    KEYWORDS.map(([keyword, subtype]) => ({
      textQuery: `${city} ${keyword}`,
      rawPrefix: `${city}_${keyword}`,
      subtype,
    })),
  );

  const onlyValue = flagValue(argv, "--only");
  if (onlyValue === undefined) return all;

  const [city, keyword, ...rest] = onlyValue.trim().split(/\s+/);
  const match = all.find((q) => q.textQuery === `${city} ${keyword}`);
  if (!match || rest.length > 0) {
    exitWithError(`--only 的值無效：「${onlyValue}」\n` + `縣市須為：${CITIES.join("、")}\n` + `關鍵字須為：${KEYWORDS.map(([k]) => k).join("、")}`);
  }
  return [match];
}

// 以 (lat, lng) 為中心、邊長 2 × radius 的正方形
function rectangleAround({ lat, lng, radius }) {
  const dLat = radius / METERS_PER_DEGREE_LAT;
  const dLng = radius / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return {
    low: { latitude: lat - dLat, longitude: lng - dLng },
    high: { latitude: lat + dLat, longitude: lng + dLng },
  };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

async function searchText(body, apiKey, fieldMask) {
  for (let attempt = 0; ; attempt += 1) {
    if (callCount >= CALL_LIMIT) throw new CallLimitError();
    callCount += 1;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`  HTTP ${res.status}，${delay / 1000} 秒後重試（第 ${attempt + 1} 次）`);
      await sleep(delay);
      continue;
    }
    throw new Error(`HTTP ${res.status}：${await res.text()}`);
  }
}

// 回傳該查詢所有頁面的 places；任一頁失敗即拋出錯誤，整個查詢視為失敗。
async function runQuery({ textQuery, rawPrefix }, apiKey, near) {
  const body = {
    textQuery,
    languageCode: "zh-TW",
    regionCode: "TW",
    pageSize: 20,
  };
  if (near) body.locationRestriction = { rectangle: rectangleAround(near) };
  const fieldMask = near ? NEAR_FIELD_MASK : FIELD_MASK;

  const places = [];
  let pageToken;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await searchText(pageToken ? { ...body, pageToken } : body, apiKey, fieldMask);
    await writeFile(`${RAW_DIR}/${rawPrefix}_p${page}.json`, JSON.stringify(data, null, 2));
    places.push(...(data.places ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return places;
}

function cityOf(place) {
  const component = (place.addressComponents ?? []).find((c) => (c.types ?? []).includes("administrative_area_level_1"));
  return (component?.longText ?? "").replaceAll("台", "臺").replaceAll("园", "園");
}

function regionOf(city) {
  for (const [region, cities] of Object.entries(REGIONS)) {
    if (cities.includes(city)) return region;
  }
  return "其他";
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const lines = rows.map((row) => row.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

async function main() {
  const argv = process.argv.slice(2);
  checkArgs(argv);
  const near = parseNear(argv);
  const queries = buildQueries(argv, near);
  const outputFile = near ? NEAR_OUTPUT_FILE : OUTPUT_FILE;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) exitWithError("找不到 GOOGLE_MAPS_API_KEY，請參考 .env.example 建立 .env。");

  await mkdir(RAW_DIR, { recursive: true });
  const fetchedAt = new Date().toISOString();
  if (near) console.log(`周邊查詢：(${near.lat}, ${near.lng})，半徑 ${near.radius} 公尺`);

  /** @type {Map<string, { place: any, subtypes: Set<string>, sources: Set<string> }>} */
  const byId = new Map();
  const failed = [];
  const truncated = [];
  let limitReached = false;

  for (const query of queries) {
    const label = query.textQuery;
    console.log(`查詢：${label}`);

    let places;
    try {
      places = await runQuery(query, apiKey, near);
    } catch (err) {
      if (err instanceof CallLimitError) {
        console.error(`已達呼叫上限 ${CALL_LIMIT} 次，立即停止。`);
        limitReached = true;
        break;
      }
      const cause = err.cause?.message ? `（${err.cause.message}）` : "";
      console.error(`  失敗，跳過：${err.message}${cause}`);
      failed.push(label);
      continue;
    }

    console.log(`  取得 ${places.length} 筆`);
    if (places.length >= 60) truncated.push(label);

    for (const place of places) {
      if (!byId.has(place.id)) {
        byId.set(place.id, { place, subtypes: new Set(), sources: new Set() });
      }
      const entry = byId.get(place.id);
      entry.subtypes.add(query.subtype);
      entry.sources.add(label);
    }
  }

  let candidates = [...byId.values()].filter(({ place }) => place.businessStatus === "OPERATIONAL");
  if (near) {
    candidates = candidates
      .filter(({ place }) => place.location)
      .map((c) => ({
        ...c,
        distance: haversineMeters(near.lat, near.lng, c.place.location.latitude, c.place.location.longitude),
      }))
      .filter((c) => c.distance <= near.radius)
      .sort((a, b) => a.distance - b.distance);
  } else {
    candidates.sort((a, b) => (b.place.userRatingCount ?? 0) - (a.place.userRatingCount ?? 0));
  }

  const rows = candidates.map(({ place, subtypes, sources, distance }) => {
    const city = cityOf(place);
    const row = [
      place.displayName?.text,
      [...subtypes].join("、"),
      place.userRatingCount,
      place.rating,
      city,
      regionOf(city),
      place.primaryTypeDisplayName?.text,
      place.formattedAddress,
      place.googleMapsUri,
      [...sources].join("、"),
      place.id,
      fetchedAt,
      "",
      "",
      "",
      "",
      "",
      "",
    ];
    if (near) row.splice(1, 0, Math.round(distance));
    return row;
  });
  const header = near ? CSV_HEADER.toSpliced(1, 0, DISTANCE_COLUMN) : CSV_HEADER;

  await writeFile(outputFile, toCsv([header, ...rows]));

  const subtypeNames = [...new Set(KEYWORDS.map(([, subtype]) => subtype))];
  console.log("\n===== 結果 =====");
  console.log(`實際呼叫次數：${callCount}`);
  console.log(`候選店總數：${candidates.length}（已寫入 ${outputFile}）`);
  console.log("各子類型候選數：");
  for (const name of subtypeNames) {
    const count = candidates.filter((c) => c.subtypes.has(name)).length;
    console.log(`  ${name}：${count}`);
  }
  console.log(`回傳達 60 筆（可能被截斷）的查詢：${truncated.length ? truncated.join("、") : "無"}`);
  if (failed.length) console.log(`失敗的查詢：${failed.join("、")}`);
  if (limitReached) console.log(`注意：因達呼叫上限 ${CALL_LIMIT} 次而提前停止，結果不完整。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
