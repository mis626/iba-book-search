/**
 * IBA Smart Book Search — V4
 * File: Code.gs
 *
 * Ye file entry point hai:
 *   - CONFIG (saari settings ek jagah)
 *   - setupProject() — ek baar chalao
 *   - onOpen() — sheet me "IBA Search" menu
 *   - doGet() — website ki saari request yahan aati hai
 *   - inventory read + 3-level cache
 */

const CONFIG = {
  /*
   * Teeno inventory sheets ka same A:F layout:
   * A SKU Code | B Item Name | C Max Level
   * D Material In Transit | E Closing Stock | F Category
   */
  SOURCE_SHEETS: ["IMS", "GOV", "COMP"],

  TREND_SHEET: "Trend",
  DICTIONARY_SHEET: "Dictionary",
  FEEDBACK_SHEET: "Feedback",
  BOOK_IMAGES_SHEET: "Book Images",
  PHOTO_HISTORY_SHEET: "Photo Search History",

  MAX_RESULTS: 50,
  MAX_SIMILAR_RESULTS: 12,
  MAX_QUERY_LENGTH: 1500,

  /*
   * Score cutoffs — search ko sakht ya narm karne ke liye
   * sirf ye do numbers badalne padte hain.
   *
   * STRONG  = "pakka yahi book hai" list
   * SIMILAR = "milti julti books" list
   */
  STRONG_SCORE_CUTOFF: 70,
  SIMILAR_SCORE_CUTOFF: 45,

  SPREADSHEET_PROPERTY: "IBA_SPREADSHEET_ID",

  /*
   * Inventory 10 minute tak cache rehti hai.
   * Stock update ke turant baad fresh data chahiye to
   * website ka "Refresh data" button dabao.
   */
  INVENTORY_CACHE_SECONDS: 600,
  INVENTORY_CACHE_PREFIX: "IBA_BOOKS_V4_",
  INVENTORY_CACHE_CHUNK_SIZE: 75000,

  CONFIRM_LOCK_TIMEOUT_MS: 30000,

  VERSION: "4.0"
};

/* Ek execution ke andar ke caches. */
var IBA_RUNTIME_BOOK_CACHE = null;
var IBA_RUNTIME_MEDIA_CACHE = null;
var IBA_RUNTIME_INDEX_CACHE = null;
var IBA_RUNTIME_SHEET_CACHE = {};

/* ------------------------------------------------------------------ */
/* SETUP + MENU                                                        */
/* ------------------------------------------------------------------ */

/**
 * Sheet khulte hi admin menu add hota hai.
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("IBA Search")
      .addItem("1. Setup / repair project", "setupProject")
      .addItem("2. Refresh search data now", "clearSearchCache")
      .addSeparator()
      .addItem("Check system health", "showHealthReport")
      .addItem("Reset Trend sheet (backup banega)", "resetTrendSheetSafely")
      .addToUi();

  } catch (error) {
    /* Trigger context me UI nahi hoti — ignore. */
    console.warn("Menu not created:", error);
  }
}

/**
 * Project paste karne ke baad ek baar chalao.
 * Dobara chalane se bhi koi data delete nahi hota.
 */
function setupProject() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error(
      "Spreadsheet detect nahi hui. Apps Script ko IMS Google Sheet ke " +
      "Extensions > Apps Script se open karo."
    );
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(CONFIG.SPREADSHEET_PROPERTY, spreadsheet.getId());

  const created = [];

  [
    ["Dictionary", ensureDictionarySheet_],
    ["Trend", ensureTrendSheet_],
    ["Feedback", ensureFeedbackSheet_],
    ["Book Images", ensureBookImagesSheet_],
    ["Photo Search History", ensurePhotoSearchHistorySheet_]
  ].forEach(function (item) {
    try {
      item[1]();
      created.push(item[0] + ": ok");
    } catch (error) {
      created.push(item[0] + ": FAILED — " + error.message);
    }
  });

  clearSearchCache_();

  const missingSources = CONFIG.SOURCE_SHEETS.filter(function (name) {
    return !spreadsheet.getSheetByName(name);
  });

  return {
    success: true,
    version: CONFIG.VERSION,
    spreadsheetName: spreadsheet.getName(),
    spreadsheetId: spreadsheet.getId(),
    sheets: created,
    missingSourceSheets: missingSources,
    message: missingSources.length
      ? "Setup ho gaya, lekin ye source sheets nahi mili: " +
        missingSources.join(", ")
      : "IBA Smart Book Search V4 setup complete."
  };
}

/**
 * Menu se system ki halat dekhne ke liye.
 */
function showHealthReport() {
  const report = buildHealthReport_();

  const lines = [
    "Version: " + report.version,
    "Total books: " + report.total,
    "IMS: " + report.ims + " | GOV: " + report.gov + " | COMP: " + report.comp,
    "Dictionary entries: " + report.dictionaryEntries,
    "Approved feedback rules: " + report.approvedFeedback,
    "Books with cover image: " + report.booksWithImage,
    "Books with barcode/ISBN: " + report.booksWithBarcode,
    "",
    "Missing sheets: " +
      (report.missingSheets.length ? report.missingSheets.join(", ") : "none"),
    "Warnings: " +
      (report.warnings.length ? report.warnings.join(" | ") : "none")
  ];

  try {
    SpreadsheetApp.getUi().alert("IBA Search — Health", lines.join("\n"),
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (error) {
    console.log(lines.join("\n"));
  }

  return report;
}

function buildHealthReport_() {
  const warnings = [];
  const missingSheets = [];

  let books = [];
  let dictionary = {};
  let approvedCount = 0;

  try {
    books = getAllBooks_();
  } catch (error) {
    warnings.push("Inventory read failed: " + error.message);
  }

  try {
    dictionary = getTrainingDictionary_();
  } catch (error) {
    warnings.push("Dictionary read failed: " + error.message);
  }

  try {
    approvedCount = getApprovedFeedbackRules_(dictionary).length;
  } catch (error) {
    warnings.push("Feedback read failed: " + error.message);
  }

  try {
    const spreadsheet = getSpreadsheet_();

    CONFIG.SOURCE_SHEETS
      .concat([
        CONFIG.TREND_SHEET,
        CONFIG.DICTIONARY_SHEET,
        CONFIG.FEEDBACK_SHEET,
        CONFIG.BOOK_IMAGES_SHEET,
        CONFIG.PHOTO_HISTORY_SHEET
      ])
      .forEach(function (name) {
        if (!spreadsheet.getSheetByName(name)) {
          missingSheets.push(name);
        }
      });

  } catch (error) {
    warnings.push("Spreadsheet open failed: " + error.message);
  }

  const counts = {};

  CONFIG.SOURCE_SHEETS.forEach(function (name) {
    counts[name.toLowerCase()] = books.filter(function (book) {
      return book.source === name;
    }).length;
  });

  const media = safeGetBookMediaMap_();

  return {
    version: CONFIG.VERSION,
    total: books.length,
    ims: counts.ims || 0,
    gov: counts.gov || 0,
    comp: counts.comp || 0,
    dictionaryEntries: Object.keys(dictionary).length,
    approvedFeedback: approvedCount,
    booksWithImage: Object.keys(media.images).length,
    booksWithBarcode: Object.keys(media.barcodeToSku).length,
    missingSheets: missingSheets,
    warnings: warnings
  };
}

/**
 * Spreadsheet handle. Property na ho to active spreadsheet
 * try karta hai, isliye setup bhoolne par bhi kaam chalta hai.
 */
function getSpreadsheet_() {
  const spreadsheetId = PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.SPREADSHEET_PROPERTY);

  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();

  if (active) {
    PropertiesService
      .getScriptProperties()
      .setProperty(CONFIG.SPREADSHEET_PROPERTY, active.getId());

    return active;
  }

  throw new Error(
    "Project setup nahi hua. Apps Script editor me setupProject ek baar Run karo."
  );
}

/**
 * Sheet handle ek execution me ek hi baar liya jaata hai.
 */
function getCachedSheet_(sheetName, ensureFunction) {
  if (IBA_RUNTIME_SHEET_CACHE[sheetName]) {
    return IBA_RUNTIME_SHEET_CACHE[sheetName];
  }

  const sheet = ensureFunction();

  IBA_RUNTIME_SHEET_CACHE[sheetName] = sheet;

  return sheet;
}

/**
 * Backup sheet ka unique naam.
 */
function getUniqueBackupSheetName_(spreadsheet, baseName) {
  const timezone = spreadsheet.getSpreadsheetTimeZone();

  const timestamp = Utilities.formatDate(
    new Date(),
    timezone,
    "yyyyMMdd_HHmmss"
  );

  let name = baseName + "_Backup_" + timestamp;
  let counter = 1;

  while (spreadsheet.getSheetByName(name)) {
    name = baseName + "_Backup_" + timestamp + "_" + counter;
    counter++;
  }

  return name;
}

/* ------------------------------------------------------------------ */
/* WEB API                                                             */
/* ------------------------------------------------------------------ */

function doGet(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  const callback = sanitizeCallback_(parameters.callback);

  let response;

  try {
    const action = String(parameters.action || "info")
      .trim()
      .toLowerCase();

    if (action === "info" || action === "health") {
      response = Object.assign(
        { success: true, photoSearchEnabled: true },
        buildHealthReport_()
      );

    } else if (action === "search") {
      response = searchBooksApi_(
        String(parameters.q || "").trim(),
        parameters
      );

    } else if (action === "confirm") {
      response = confirmSearchApi_(
        String(parameters.q || "").trim(),
        String(parameters.confirmationId || "").trim(),
        parameters
      );

    } else if (action === "feedback") {
      response = submitFeedbackApi_(parameters);

    } else if (action === "dictionary") {
      const dictionary = getTrainingDictionary_();

      response = {
        success: true,
        total: Object.keys(dictionary).length,
        dictionary: dictionary
      };

    } else if (action === "clearcache") {
      clearSearchCache_();

      response = Object.assign(
        {
          success: true,
          message: "Search data refresh ho gaya."
        },
        buildHealthReport_()
      );

    } else {
      response = {
        success: false,
        message: "Invalid API action: " + action
      };
    }

  } catch (error) {
    console.error("doGet failed:", error);

    response = {
      success: false,
      message: error && error.message ? error.message : String(error)
    };
  }

  return createApiResponse_(response, callback);
}

/*
 * POST bhi support hai — lambe OCR text ke liye website
 * POST use karti hai taaki URL limit cross na ho.
 */
function doPost(e) {
  const parameters = {};

  try {
    if (e && e.parameter) {
      Object.keys(e.parameter).forEach(function (key) {
        parameters[key] = e.parameter[key];
      });
    }

    if (e && e.postData && e.postData.contents) {
      const parsed = JSON.parse(e.postData.contents);

      Object.keys(parsed).forEach(function (key) {
        parameters[key] = parsed[key];
      });
    }

  } catch (error) {
    console.warn("POST body parse failed:", error);
  }

  return doGet({ parameter: parameters });
}

function createApiResponse_(data, callback) {
  let json;

  try {
    json = JSON.stringify(data);
  } catch (error) {
    json = JSON.stringify({
      success: false,
      message: "Response banane me problem: " + error.message
    });
  }

  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeCallback_(value) {
  const callback = String(value || "").trim();

  if (!callback) {
    return "";
  }

  return /^[A-Za-z_$][A-Za-z0-9_$.]{0,100}$/.test(callback) ? callback : "";
}

/* ------------------------------------------------------------------ */
/* INVENTORY                                                           */
/* ------------------------------------------------------------------ */

/**
 * Stock text ko number banata hai. "1,250" -> 1250, "" -> 0
 */
function parseStockNumber_(value) {
  const cleaned = String(value === null || value === undefined ? "" : value)
    .replace(/,/g, "")
    .replace(/[^0-9.\-]/g, "")
    .trim();

  if (!cleaned) {
    return 0;
  }

  const number = Number(cleaned);

  return Number.isFinite(number) ? number : 0;
}

/**
 * IMS + GOV + COMP padhta hai.
 * Ek sheet missing ho ya khali ho to baaki chalti rehti hain.
 */
function readAllBooksFromSheets_() {
  const spreadsheet = getSpreadsheet_();
  const books = [];

  CONFIG.SOURCE_SHEETS.forEach(function (sheetName) {
    try {
      const sheet = spreadsheet.getSheetByName(sheetName);

      if (!sheet) {
        return;
      }

      const lastRow = sheet.getLastRow();

      if (lastRow < 2) {
        return;
      }

      const rows = sheet
        .getRange(2, 1, lastRow - 1, 6)
        .getDisplayValues();

      rows.forEach(function (row, rowIndex) {
        const sku = String(row[0] || "").trim();
        const name = String(row[1] || "").trim();

        if (!sku && !name) {
          return;
        }

        books.push({
          source: sheetName,
          sourceRow: rowIndex + 2,
          sku: sku,
          name: name,
          maxLevel: String(row[2] || "").trim(),
          materialInTransit: String(row[3] || "").trim(),
          closingStock: parseStockNumber_(row[4]),
          category: String(row[5] || "").trim()
        });
      });

    } catch (error) {
      console.warn("Sheet read failed for " + sheetName + ":", error);
    }
  });

  return books;
}

/**
 * Book Images sheet padhta hai.
 * Column E me barcode/ISBN number ho to wo lookup ke liye use hota hai.
 * URL ho to wo ignore hota hai.
 */
function getBookMediaMap_() {
  if (IBA_RUNTIME_MEDIA_CACHE) {
    return IBA_RUNTIME_MEDIA_CACHE;
  }

  const images = {};
  const barcodeToSku = {};

  try {
    const spreadsheet = getSpreadsheet_();
    const sheet = spreadsheet.getSheetByName(CONFIG.BOOK_IMAGES_SHEET);

    if (sheet && sheet.getLastRow() >= 2) {
      const rows = sheet
        .getRange(2, 1, sheet.getLastRow() - 1, BOOK_IMAGES_HEADERS.length)
        .getDisplayValues();

      rows.forEach(function (row) {
        const sku = basicNormalize_(row[0]);
        const frontCover = String(row[2] || "").trim();
        const barcodeCell = String(row[4] || "").trim();
        const activeValue = String(row[5] || "").trim().toLowerCase();

        if (!sku) {
          return;
        }

        if (
          activeValue === "no" ||
          activeValue === "false" ||
          activeValue === "0"
        ) {
          return;
        }

        if (frontCover && /^https?:\/\//i.test(frontCover)) {
          images[sku] = frontCover;
        }

        /* URL nahi, sirf number ho to wo barcode/ISBN hai. */
        if (barcodeCell && !/^https?:\/\//i.test(barcodeCell)) {
          const digits = barcodeCell.replace(/\D/g, "");

          if (digits.length >= 8) {
            barcodeToSku[digits] = String(row[0] || "").trim();
          }
        }
      });
    }

  } catch (error) {
    console.warn("Book Images read failed:", error);
  }

  IBA_RUNTIME_MEDIA_CACHE = {
    images: images,
    barcodeToSku: barcodeToSku
  };

  return IBA_RUNTIME_MEDIA_CACHE;
}

function safeGetBookMediaMap_() {
  try {
    return getBookMediaMap_();
  } catch (error) {
    return { images: {}, barcodeToSku: {} };
  }
}

/* ---- Script cache (chunked) ---- */

function getInventoryCacheMetaKey_() {
  let spreadsheetId = "UNKNOWN";

  try {
    spreadsheetId = PropertiesService
      .getScriptProperties()
      .getProperty(CONFIG.SPREADSHEET_PROPERTY) || "UNKNOWN";
  } catch (error) {
    /* ignore */
  }

  return CONFIG.INVENTORY_CACHE_PREFIX +
    Utilities.base64EncodeWebSafe(spreadsheetId).substring(0, 80) +
    "_META";
}

function getInventoryCacheChunkKey_(index) {
  return getInventoryCacheMetaKey_() + "_CHUNK_" + index;
}

function writeInventoryCache_(books) {
  const cache = CacheService.getScriptCache();
  const json = JSON.stringify(books);
  const chunks = [];

  for (
    let start = 0;
    start < json.length;
    start += CONFIG.INVENTORY_CACHE_CHUNK_SIZE
  ) {
    chunks.push(
      json.substring(start, start + CONFIG.INVENTORY_CACHE_CHUNK_SIZE)
    );
  }

  /* 40 chunk se zyada = ~3 MB. Itna cache reliable nahi, skip karo. */
  if (chunks.length > 40) {
    return;
  }

  const payload = {};

  chunks.forEach(function (chunk, index) {
    payload[getInventoryCacheChunkKey_(index)] = chunk;
  });

  payload[getInventoryCacheMetaKey_()] = JSON.stringify({
    chunkCount: chunks.length,
    createdAt: Date.now()
  });

  cache.putAll(payload, CONFIG.INVENTORY_CACHE_SECONDS);
}

function readInventoryCache_() {
  const cache = CacheService.getScriptCache();
  const metaText = cache.get(getInventoryCacheMetaKey_());

  if (!metaText) {
    return null;
  }

  try {
    const meta = JSON.parse(metaText);
    const chunkCount = Number(meta.chunkCount || 0);

    if (!chunkCount) {
      return null;
    }

    const keys = [];

    for (let index = 0; index < chunkCount; index++) {
      keys.push(getInventoryCacheChunkKey_(index));
    }

    const values = cache.getAll(keys);
    const chunks = [];

    for (let index = 0; index < chunkCount; index++) {
      const chunk = values[keys[index]];

      if (chunk === null || chunk === undefined) {
        return null;
      }

      chunks.push(chunk);
    }

    return JSON.parse(chunks.join(""));

  } catch (error) {
    return null;
  }
}

/**
 * Inventory ka single access point.
 * Level 1: is execution ki memory
 * Level 2: script cache (10 min)
 * Level 3: sheets
 */
function getAllBooks_() {
  if (Array.isArray(IBA_RUNTIME_BOOK_CACHE)) {
    return IBA_RUNTIME_BOOK_CACHE;
  }

  let cached = null;

  try {
    cached = readInventoryCache_();
  } catch (error) {
    console.warn("Inventory cache read failed:", error);
  }

  if (Array.isArray(cached) && cached.length) {
    IBA_RUNTIME_BOOK_CACHE = cached;
    return cached;
  }

  const books = readAllBooksFromSheets_();

  IBA_RUNTIME_BOOK_CACHE = books;

  try {
    writeInventoryCache_(books);
  } catch (error) {
    /* Cache fail hone se search kabhi nahi rukni chahiye. */
    console.warn("Inventory cache write failed:", error);
  }

  return books;
}

function clearSearchCache_() {
  IBA_RUNTIME_BOOK_CACHE = null;
  IBA_RUNTIME_MEDIA_CACHE = null;
  IBA_RUNTIME_INDEX_CACHE = null;
  IBA_RUNTIME_SHEET_CACHE = {};
  IBA_DICTIONARY_CACHE = null;
  IBA_COMPILED_DICTIONARY = null;
  IBA_FEEDBACK_RULES_CACHE = null;
  IBA_NORMALIZE_CACHE = {};
  IBA_NORMALIZE_CACHE_COUNT = 0;
  IBA_TOKEN_CACHE = {};
  IBA_TOKEN_CACHE_COUNT = 0;

  try {
    const cache = CacheService.getScriptCache();
    const metaText = cache.get(getInventoryCacheMetaKey_());
    const keys = [getInventoryCacheMetaKey_()];

    if (metaText) {
      const meta = JSON.parse(metaText);

      for (let index = 0; index < Number(meta.chunkCount || 0); index++) {
        keys.push(getInventoryCacheChunkKey_(index));
      }
    }

    cache.removeAll(keys);

  } catch (error) {
    console.warn("Cache clear warning:", error);
  }

  return true;
}

/**
 * Menu / manual use ke liye.
 */
function clearSearchCache() {
  clearSearchCache_();

  const report = buildHealthReport_();

  try {
    SpreadsheetApp.getUi().alert(
      "Search data refresh ho gaya.\n\n" +
      "Books: " + report.total +
      " (IMS " + report.ims +
      " / GOV " + report.gov +
      " / COMP " + report.comp + ")"
    );
  } catch (error) {
    /* UI available nahi. */
  }

  return {
    success: true,
    message: "Search cache cleared. Agli search fresh data padhegi.",
    total: report.total
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH                                                              */
/* ------------------------------------------------------------------ */

function validateSearchInput_(searchInput) {
  const input = String(searchInput || "").trim();

  if (!input) {
    throw new Error("Book ka naam type, bol ya scan karo.");
  }

  return input.length > CONFIG.MAX_QUERY_LENGTH
    ? input.substring(0, CONFIG.MAX_QUERY_LENGTH)
    : input;
}

/**
 * Search index — ek execution me ek hi baar banta hai.
 * V3 me ye photo search par 4 baar banta tha.
 */
function getSearchIndex_(dictionary) {
  const books = getAllBooks_();

  if (
    IBA_RUNTIME_INDEX_CACHE &&
    IBA_RUNTIME_INDEX_CACHE.books === books &&
    IBA_RUNTIME_INDEX_CACHE.dictionary === dictionary
  ) {
    return IBA_RUNTIME_INDEX_CACHE.index;
  }

  const index = buildBookSearchIndex_(books, dictionary);

  IBA_RUNTIME_INDEX_CACHE = {
    books: books,
    dictionary: dictionary,
    index: index
  };

  return index;
}

/**
 * Ek ya multiple query chalata hai.
 * Textarea me nayi line ya comma se alag-alag search hoti hai.
 */
function executeSearch_(searchInput) {
  const input = validateSearchInput_(searchInput);
  const dictionary = getTrainingDictionary_();
  const indexedBooks = getSearchIndex_(dictionary);
  const feedbackRules = getApprovedFeedbackRules_(dictionary);

  const queries = input
    .split(/\n|,/)
    .map(function (value) {
      return value.trim();
    })
    .filter(Boolean)
    .slice(0, 25);

  const output = [];

  (queries.length ? queries : [input]).forEach(function (query) {
    let searchResult;

    try {
      searchResult = findRelevantBooks_(
        query,
        indexedBooks,
        dictionary,
        feedbackRules
      );

    } catch (error) {
      console.error("Query failed: " + query, error);

      searchResult = {
        matches: [],
        similar: [],
        error: error.message
      };
    }

    output.push({
      query: query,
      trainedQuery: applyTrainingDictionary_(query, dictionary),
      normalizedQuery: canonicalText_(query, dictionary),
      matches: searchResult.matches,
      similar: searchResult.similar,
      approvedPin: searchResult.approvedPin || null,
      error: searchResult.error || ""
    });
  });

  return {
    dictionary: dictionary,
    results: output
  };
}

/**
 * action=search
 * Photo request me pehle OCR se book ka naam nikaala jaata hai,
 * poora OCR paragraph kabhi query nahi banta.
 */
function searchBooksApi_(searchInput, requestParameters) {
  let effectiveInput = searchInput;
  let photoAnalysis = null;

  if (hasPhotoMetadata_(requestParameters)) {
    try {
      photoAnalysis = analyzePhotoSearch_(requestParameters, searchInput);

      if (photoAnalysis.searchQuery) {
        effectiveInput = photoAnalysis.searchQuery;
      }

    } catch (error) {
      console.error("Photo analysis failed:", error);

      photoAnalysis = {
        method: "failed",
        message: error.message,
        confidence: 0,
        searchQuery: ""
      };
    }
  }

  const searchData = executeSearch_(effectiveInput);

  let strongCount = 0;
  let similarCount = 0;

  searchData.results.forEach(function (result) {
    strongCount += result.matches.length;
    similarCount += result.similar.length;
  });

  return {
    success: true,
    version: CONFIG.VERSION,
    queryCount: searchData.results.length,
    effectiveQuery: effectiveInput,
    strongCount: strongCount,
    similarCount: similarCount,
    photoAnalysis: photoAnalysis,
    results: searchData.results
  };
}

/**
 * action=confirm — "Yes, result sahi hai"
 * Idempotent hai: same confirmationId dobara aaye to
 * Trend me duplicate row nahi banti.
 */
function confirmSearchApi_(searchInput, confirmationId, requestParameters) {
  let input = validateSearchInput_(searchInput);

  if (hasPhotoMetadata_(requestParameters)) {
    try {
      const photoAnalysis = analyzePhotoSearch_(requestParameters, input);

      if (photoAnalysis.searchQuery) {
        input = photoAnalysis.searchQuery;
      }

    } catch (error) {
      console.warn("Confirm photo analysis failed:", error);
    }
  }

  const safeConfirmationId = String(confirmationId || "").trim();

  if (!safeConfirmationId) {
    throw new Error("Confirmation ID missing hai.");
  }

  const cache = CacheService.getScriptCache();

  const cacheKey = "IBA_CONFIRM_" +
    Utilities.base64EncodeWebSafe(safeConfirmationId).substring(0, 180);

  if (cache.get(cacheKey)) {
    return {
      success: true,
      alreadySaved: true,
      savedQueries: 0,
      savedRows: 0,
      message: "Ye result Trend sheet me pehle hi save hai."
    };
  }

  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    hasLock = lock.tryLock(CONFIG.CONFIRM_LOCK_TIMEOUT_MS);

    if (!hasLock) {
      throw new Error(
        "System abhi busy hai. 5 second baad dobara Yes dabao."
      );
    }

    if (cache.get(cacheKey)) {
      return {
        success: true,
        alreadySaved: true,
        savedQueries: 0,
        savedRows: 0,
        message: "Ye result Trend sheet me pehle hi save hai."
      };
    }

    const searchData = executeSearch_(input);
    let savedRows = 0;

    searchData.results.forEach(function (queryResult) {
      logSearchHistoryUnlocked_(
        queryResult.query,
        queryResult.matches,
        searchData.dictionary,
        queryResult.approvedPin
      );

      savedRows += queryResult.matches.length || 1;
    });

    if (hasPhotoMetadata_(requestParameters)) {
      try {
        logPhotoSearchDecision_(
          Object.assign({}, requestParameters, { finalQuery: input }),
          searchData.results,
          "Yes"
        );
      } catch (error) {
        console.warn("Photo history log failed:", error);
      }
    }

    cache.put(cacheKey, "SAVED", 21600);

    return {
      success: true,
      alreadySaved: false,
      savedQueries: searchData.results.length,
      savedRows: savedRows,
      effectiveQuery: input,
      message: "Search aur result Trend sheet me save ho gaya."
    };

  } finally {
    if (hasLock && lock.hasLock()) {
      lock.releaseLock();
    }
  }
}
