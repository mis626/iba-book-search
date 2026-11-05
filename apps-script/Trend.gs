/**
 * IBA Smart Book Search — V4
 * File: Trend.gs   (purani Trend.gs ko poori replace karo)
 *
 * Trend sheet me sirf tab likha jaata hai jab user
 * "Yes, result sahi hai" dabata hai.
 *
 * Columns V3 wale hi hain, isliye tumhari existing Trend sheet
 * rename/backup nahi hogi. Sirf ye do cheezein badli hain:
 *   - Closing Stock ab hamesha number hai (Looker Studio ke liye)
 *   - Remarks me batata hai ki result approved feedback se aaya tha
 */

const TREND_HEADERS = [
  "Date Time",
  "Date",
  "Time",
  "Search Text",
  "Trained Search",
  "Normalized Search",
  "Search Status",
  "Output Rank",
  "SKU Code",
  "Item Name",
  "Category",
  "Closing Stock",
  "Source Sheet",
  "Match %",
  "Final Correct SKU",
  "Remarks"
];

function ensureTrendSheet_() {
  const spreadsheet = getSpreadsheet_();

  let sheet = spreadsheet.getSheetByName(CONFIG.TREND_SHEET);

  if (sheet && !trendHeadersAreCorrect_(sheet)) {
    sheet.setName(
      getUniqueBackupSheetName_(spreadsheet, CONFIG.TREND_SHEET)
    );
    sheet = null;
  }

  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.TREND_SHEET);
    createTrendHeaders_(sheet);
  }

  return sheet;
}

function trendHeadersAreCorrect_(sheet) {
  if (!sheet || sheet.getMaxColumns() < TREND_HEADERS.length) {
    return false;
  }

  const currentHeaders = sheet
    .getRange(1, 1, 1, TREND_HEADERS.length)
    .getDisplayValues()[0]
    .map(function (value) {
      return String(value || "").trim();
    });

  return TREND_HEADERS.every(function (header, index) {
    return currentHeaders[index] === header;
  });
}

function createTrendHeaders_(sheet) {
  if (sheet.getMaxColumns() < TREND_HEADERS.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      TREND_HEADERS.length - sheet.getMaxColumns()
    );
  }

  sheet
    .getRange(1, 1, 1, TREND_HEADERS.length)
    .setValues([TREND_HEADERS])
    .setFontWeight("bold")
    .setBackground("#2C3A54")
    .setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");

  sheet.setFrozenRows(1);

  [155, 105, 90, 220, 220, 220, 110, 90, 145, 350, 230, 115, 130, 90, 160, 300]
    .forEach(function (width, index) {
      sheet.setColumnWidth(index + 1, width);
    });
}

/**
 * Lock ke saath Trend write (standalone use ke liye).
 */
function logSearchHistory_(searchText, results, dictionary, approvedPin) {
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    hasLock = lock.tryLock(30000);

    if (!hasLock) {
      throw new Error("Trend sheet busy hai, thodi der baad try karo.");
    }

    return logSearchHistoryUnlocked_(
      searchText,
      results,
      dictionary,
      approvedPin
    );

  } finally {
    if (hasLock && lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

/**
 * Actual writer. confirmSearchApi_ pehle se lock leke baitha hai,
 * isliye ye dobara lock nahi leta.
 */
function logSearchHistoryUnlocked_(
  searchText,
  results,
  dictionary,
  approvedPin
) {
  const spreadsheet = getSpreadsheet_();
  const sheet = getCachedSheet_(CONFIG.TREND_SHEET, ensureTrendSheet_);

  const now = new Date();
  const timezone = spreadsheet.getSpreadsheetTimeZone();

  const dateText = Utilities.formatDate(now, timezone, "dd/MM/yyyy");
  const timeText = Utilities.formatDate(now, timezone, "HH:mm:ss");

  const originalSearch = String(searchText || "").trim();
  const trainedSearch = applyTrainingDictionary_(originalSearch, dictionary);
  const normalizedSearch = canonicalText_(originalSearch, dictionary);

  const pinnedSku = approvedPin && approvedPin.sku
    ? basicNormalize_(approvedPin.sku)
    : "";

  const rows = [];

  if (Array.isArray(results) && results.length) {
    results.forEach(function (result, index) {
      const isPinned = pinnedSku &&
        basicNormalize_(result.sku) === pinnedSku;

      const remarks = [];

      if (isPinned || result.feedbackPreferred) {
        remarks.push("Approved feedback se top par aaya");
      }

      if (result.resultType === "similar") {
        remarks.push("Similar result");
      }

      if (
        Array.isArray(result.stockBySource) &&
        result.stockBySource.length > 1
      ) {
        remarks.push("Stock: " + result.stockLabel);
      }

      rows.push([
        now,
        dateText,
        timeText,
        originalSearch,
        trainedSearch,
        normalizedSearch,
        "Matched",
        index + 1,
        String(result.sku || "").trim(),
        String(result.name || "").trim(),
        String(result.category || "").trim(),
        normalizeTrendNumber_(result.closingStock),
        String(result.source || "").trim(),
        normalizeTrendScore_(result.score),
        "",
        remarks.join(" | ")
      ]);
    });

  } else {
    rows.push([
      now,
      dateText,
      timeText,
      originalSearch,
      trainedSearch,
      normalizedSearch,
      "No Match",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "Koi relevant result nahi mila"
    ]);
  }

  const startRow = Math.max(sheet.getLastRow() + 1, 2);

  sheet
    .getRange(startRow, 1, rows.length, TREND_HEADERS.length)
    .setValues(rows);

  sheet
    .getRange(startRow, 1, rows.length, 1)
    .setNumberFormat("dd/MM/yyyy HH:mm:ss");

  sheet
    .getRange(startRow, 2, rows.length, 1)
    .setNumberFormat("dd/MM/yyyy");

  sheet
    .getRange(startRow, 3, rows.length, 1)
    .setNumberFormat("HH:mm:ss");

  sheet
    .getRange(startRow, 12, rows.length, 1)
    .setNumberFormat("0");

  sheet
    .getRange(startRow, 14, rows.length, 1)
    .setNumberFormat('0"%"');

  return true;
}

function normalizeTrendNumber_(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return 0;
  }

  const cleaned = String(value).replace(/,/g, "").trim();
  const number = Number(cleaned);

  /*
   * V3 me multi-source stock text ("IMS: 12 | GOV: 5") yahan
   * aakar column ko mixed bana deta tha. V4 me sirf number aata hai,
   * lekin safety ke liye ye guard rakha hai.
   */
  if (Number.isFinite(number)) {
    return number;
  }

  const digits = cleaned.match(/-?\d+(\.\d+)?/g);

  if (!digits) {
    return 0;
  }

  return digits.reduce(function (total, item) {
    return total + Number(item);
  }, 0);
}

function normalizeTrendScore_(value) {
  const cleaned = String(value === null || value === undefined ? "" : value)
    .replace(/%/g, "")
    .trim();

  if (!cleaned) {
    return "";
  }

  const score = Number(cleaned);

  return Number.isFinite(score)
    ? Math.max(0, Math.min(100, Math.round(score)))
    : "";
}

/**
 * Menu se: purani Trend sheet backup karke nayi banata hai.
 */
function resetTrendSheetSafely() {
  const spreadsheet = getSpreadsheet_();
  const oldSheet = spreadsheet.getSheetByName(CONFIG.TREND_SHEET);

  let backupName = "";

  if (oldSheet) {
    backupName = getUniqueBackupSheetName_(spreadsheet, CONFIG.TREND_SHEET);
    oldSheet.setName(backupName);
  }

  const newSheet = spreadsheet.insertSheet(CONFIG.TREND_SHEET);

  createTrendHeaders_(newSheet);

  IBA_RUNTIME_SHEET_CACHE = {};

  try {
    SpreadsheetApp.getUi().alert(
      "Nayi Trend sheet ban gayi.\n\n" +
      (backupName ? "Purana data yahan hai: " + backupName : "")
    );
  } catch (error) {
    /* UI available nahi. */
  }

  return {
    success: true,
    backupSheet: backupName,
    newSheet: CONFIG.TREND_SHEET
  };
}
