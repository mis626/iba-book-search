/**
 * IBA Smart Book Search — V4
 * File: Feedback.gs   (purani Feedback.gs ko poori replace karo)
 *
 * Poora feedback loop:
 *
 *  1. User "No, result galat hai" dabata hai aur expected book batata hai
 *  2. Row Feedback sheet me jaati hai, Status = Pending
 *  3. Tum Status column me "Approve" ya "Approved" likhte ho
 *  4. Website par "Refresh data" dabao (ya 10 minute ruko)
 *  5. Ab usi ya milte julte search par wahi book sabse upar aayegi
 *
 * V3 me Status sirf exactly "approved" par kaam karta tha aur search text
 * bilkul same hona zaroori tha. V4 me "approve/approved/yes/ok/done" sab
 * chalte hain, aur 75% words match hone par bhi rule lag jaata hai.
 */

const FEEDBACK_HEADERS = [
  "Date Time",
  "Search Text",
  "Normalized Search",
  "Feedback Type",
  "Selected SKU",
  "Expected Book",
  "Expected SKU",
  "Suggested Canonical",
  "Status",
  "Admin Remarks"
];

/* Status column me ye sab "approved" maane jaate hain. */
const FEEDBACK_APPROVED_WORDS = new Set([
  "approve", "approved", "approv", "aprove", "aproved",
  "yes", "y", "ok", "okay", "done", "live", "active",
  "sahi", "confirm", "confirmed", "accept", "accepted"
]);

var IBA_FEEDBACK_RULES_CACHE = null;

/**
 * Feedback sheet banata hai. Data kabhi delete nahi hota —
 * header galat ho to purani sheet backup naam se rename hoti hai.
 */
function ensureFeedbackSheet_() {
  const spreadsheet = getSpreadsheet_();

  let sheet = spreadsheet.getSheetByName(CONFIG.FEEDBACK_SHEET);

  if (sheet) {
    const firstHeader = String(
      sheet.getRange(1, 1).getValue() || ""
    ).trim();

    if (firstHeader === FEEDBACK_HEADERS[0]) {
      return sheet;
    }

    sheet.setName(
      getUniqueBackupSheetName_(spreadsheet, CONFIG.FEEDBACK_SHEET)
    );
  }

  sheet = spreadsheet.insertSheet(CONFIG.FEEDBACK_SHEET);

  sheet
    .getRange(1, 1, 1, FEEDBACK_HEADERS.length)
    .setValues([FEEDBACK_HEADERS])
    .setFontWeight("bold")
    .setBackground("#2C3A54")
    .setFontColor("#FFFFFF");

  sheet.setFrozenRows(1);

  [155, 240, 240, 150, 150, 320, 150, 300, 110, 300]
    .forEach(function (width, index) {
      sheet.setColumnWidth(index + 1, width);
    });

  /* Status column me dropdown, taaki typo na ho. */
  try {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["Pending", "Approved", "Rejected"], true)
      .setAllowInvalid(true)
      .build();

    sheet.getRange(2, 9, 2000, 1).setDataValidation(rule);

  } catch (error) {
    console.warn("Status dropdown not applied:", error);
  }

  return sheet;
}

/**
 * Website se feedback aata hai.
 */
function submitFeedbackApi_(parameters) {
  const searchText = String(parameters.searchText || "").trim();

  const feedbackType = String(parameters.feedbackType || "wrong")
    .trim()
    .toLowerCase();

  const selectedSku = String(parameters.selectedSku || "").trim();
  const expectedBook = String(parameters.expectedBook || "").trim();
  const expectedSku = String(parameters.expectedSku || "").trim();
  const note = String(parameters.note || "").trim();

  if (!searchText) {
    return {
      success: false,
      message: "Search text missing hai."
    };
  }

  if (
    feedbackType !== "correct" &&
    !expectedBook &&
    !expectedSku &&
    !selectedSku
  ) {
    return {
      success: false,
      message: "Expected book name ya SKU likhna zaroori hai."
    };
  }

  const dictionary = getTrainingDictionary_();
  const books = getAllBooks_();

  const targetSku = expectedSku || selectedSku;
  let targetBook = findBookBySku_(targetSku, books);

  /*
   * SKU nahi diya lekin book ka naam diya hai to naam se
   * inventory me book dhoondh lo — approval ke waqt kaam aayega.
   */
  if (!targetBook && expectedBook) {
    targetBook = findBookByNameText_(expectedBook, dictionary);
  }

  let suggestedCanonical = "";

  if (targetBook) {
    suggestedCanonical = canonicalText_(
      targetBook.name + " " + (targetBook.category || ""),
      dictionary
    );

  } else if (expectedBook) {
    suggestedCanonical = canonicalText_(expectedBook, dictionary);
  }

  if (!suggestedCanonical) {
    suggestedCanonical = canonicalText_(searchText, dictionary);
  }

  const normalizedSearch = canonicalText_(searchText, dictionary);
  const sheet = getCachedSheet_(CONFIG.FEEDBACK_SHEET, ensureFeedbackSheet_);
  const now = new Date();

  const resolvedSku = expectedSku ||
    (targetBook ? targetBook.sku : "") ||
    "";

  sheet.appendRow([
    now,
    searchText,
    normalizedSearch,
    feedbackType === "correct"
      ? "Correct Result"
      : "Wrong / Missing Result",
    selectedSku,
    expectedBook || (targetBook ? targetBook.name : ""),
    resolvedSku,
    suggestedCanonical,
    /*
     * Sab kuch Pending par jaata hai. Approval sirf tum Status
     * column me "Approved" likh kar dete ho — website se koi
     * apne aap book pin nahi kar sakta.
     */
    "Pending",
    note
  ]);

  const rowNumber = sheet.getLastRow();

  sheet.getRange(rowNumber, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");

  /*
   * Dictionary suggestion sirf tab, jab search chhoti ho —
   * yaani wo asli alias lagti ho ("pe 10", "kala").
   * Lambi query se Dictionary me kachra jama hota hai.
   */
  let dictionaryResult = {
    added: false,
    reason: "Search text alias jaisa nahi tha, Dictionary me kuch add nahi kiya."
  };

  const searchTokenCount = normalizedSearch
    ? normalizedSearch.split(" ").length
    : 0;

  if (searchTokenCount >= 1 && searchTokenCount <= 3 && suggestedCanonical) {
    try {
      dictionaryResult = addDictionaryTrainingSuggestion_(
        normalizedSearch,
        suggestedCanonical,
        expectedBook,
        "Feedback row " + rowNumber +
          (resolvedSku ? " | SKU: " + resolvedSku : "")
      );
    } catch (error) {
      dictionaryResult = {
        added: false,
        reason: "Dictionary write failed: " + error.message
      };
    }
  }

  if (hasPhotoMetadata_(parameters)) {
    try {
      logPhotoSearchDecision_(
        parameters,
        [],
        feedbackType === "correct" ? "Yes" : "No",
        {
          expectedBook: expectedBook,
          expectedSku: resolvedSku,
          selectedSku: selectedSku,
          remarks: note
        }
      );
    } catch (error) {
      console.warn("Photo feedback log failed:", error);
    }
  }

  /* Nayi row ke baad rules cache purana ho gaya. */
  IBA_FEEDBACK_RULES_CACHE = null;

  return {
    success: true,
    feedbackRow: rowNumber,
    resolvedSku: resolvedSku,
    resolvedBook: targetBook ? targetBook.name : "",
    message: feedbackType === "correct"
      ? "Feedback save ho gaya."
      : "Feedback sheet ki row " + rowNumber + " me save ho gaya. " +
        "Status column me \"Approved\" likhne ke baad ye book " +
        "is search par sabse upar aayegi.",
    dictionarySuggestion: dictionaryResult
  };
}

/**
 * Book ka naam de kar inventory me dhoondhna.
 * Approval ke waqt SKU resolve karne ke liye.
 */
function findBookByNameText_(nameText, dictionary) {
  const canonical = canonicalText_(nameText, dictionary);

  if (!canonical) {
    return null;
  }

  const indexedBooks = getSearchIndex_(dictionary);

  let best = null;
  let bestScore = 0;

  const queryInfo = buildQueryInfo_(nameText, dictionary);

  indexedBooks.forEach(function (book) {
    const evaluation = scoreBookAgainstQuery_(queryInfo, book);

    if (evaluation && evaluation.score > bestScore) {
      bestScore = evaluation.score;
      best = book;
    }
  });

  return bestScore >= 80 ? best : null;
}

/**
 * Status value approved hai ya nahi.
 */
function isFeedbackApproved_(statusValue) {
  const status = String(statusValue || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (!status) {
    return false;
  }

  if (FEEDBACK_APPROVED_WORDS.has(status)) {
    return true;
  }

  /* "approvedbyprayassir" jaise value bhi chalega. */
  return status.indexOf("approve") === 0;
}

/**
 * Approved feedback ko search rules me badalta hai.
 *
 * Ek rule = { canonical, tokens, sku, row }
 * SearchEngine.gs ka matchApprovedRule_() inhe use karta hai.
 */
function getApprovedFeedbackRules_(dictionary) {
  if (IBA_FEEDBACK_RULES_CACHE) {
    return IBA_FEEDBACK_RULES_CACHE;
  }

  const rules = [];

  try {
    const spreadsheet = getSpreadsheet_();
    const sheet = spreadsheet.getSheetByName(CONFIG.FEEDBACK_SHEET);

    if (sheet && sheet.getLastRow() >= 2) {
      const rows = sheet
        .getRange(2, 1, sheet.getLastRow() - 1, FEEDBACK_HEADERS.length)
        .getDisplayValues();

      rows.forEach(function (row, rowIndex) {
        if (!isFeedbackApproved_(row[8])) {
          return;
        }

        const searchText = String(row[1] || "").trim();
        const storedNormalized = String(row[2] || "").trim();
        const selectedSku = String(row[4] || "").trim();
        const expectedSku = String(row[6] || "").trim();

        const sku = expectedSku || selectedSku;

        if (!sku) {
          return;
        }

        /*
         * Column C par bharosa nahi karte — usko dobara banate hain,
         * kyunki Dictionary badalne se normalization badal sakti hai.
         */
        const canonical = searchText
          ? canonicalText_(searchText, dictionary)
          : basicNormalize_(storedNormalized);

        if (!canonical) {
          return;
        }

        const ruleTokens = canonical.split(" ").filter(Boolean);

        rules.push({
          canonical: canonical,
          sortedCanonical: ruleTokens.slice().sort().join(" "),
          tokens: ruleTokens,
          sku: sku,
          row: rowIndex + 2
        });
      });
    }

  } catch (error) {
    console.warn("Approved feedback read failed:", error);
  }

  /*
   * Baad wali row jeetegi — same search ke do approvals me
   * latest decision hi lagta hai.
   */
  const byCanonical = {};

  rules.forEach(function (rule) {
    byCanonical[rule.canonical] = rule;
  });

  IBA_FEEDBACK_RULES_CACHE = Object.keys(byCanonical).map(function (key) {
    return byCanonical[key];
  });

  return IBA_FEEDBACK_RULES_CACHE;
}
