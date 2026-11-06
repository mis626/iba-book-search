/**
 * IBA Smart Book Search — V4
 * File: PhotoSearch.gs
 *
 * Photo se book dhoondhne ka logic.
 *
 * Kaam ka order:
 *   1. Barcode / ISBN — agar Book Images sheet me registered hai to
 *      seedha wahi book (sabse pakka)
 *   2. OCR text se book ka NAAM nikaalna (poora paragraph nahi)
 *   3. Us naam ko inventory se match karna
 *   4. Kuch pakka na mile to top 3 title lines se multi-search
 *
 * V3 ki badi galti thi: barcode ke digits ko hi search query bana
 * dena. Digits kisi SKU/naam se match nahi karte the, isliye zero
 * result aata tha lekin confidence 90% dikhta tha. V4 me barcode
 * sirf lookup ke liye hai.
 *
 * Hindi support: OCR se aaya Devanagari text bhi chalega —
 * basicNormalize_ usko automatically Latin me badal deta hai.
 */

const BOOK_IMAGES_HEADERS = [
  "SKU",
  "Item Name",
  "Front Cover URL",
  "Back Cover URL",
  "Barcode / ISBN",
  "Active",
  "Remarks"
];

const PHOTO_HISTORY_HEADERS = [
  "Date Time",
  "Search ID",
  "File Name",
  "File Type",
  "File Size",
  "Image Width",
  "Image Height",
  "OCR Text",
  "Barcode",
  "Final Query",
  "Status",
  "Result Count",
  "Top SKU",
  "Top Item",
  "Top Category",
  "Closing Stock",
  "Source",
  "Match %",
  "User Decision",
  "Expected Book",
  "Expected SKU",
  "Remarks"
];

/* Cover par likhi wo lines jo kabhi book ka naam nahi hoti. */
const PHOTO_NOISE_PATTERNS = [
  /^isbn\b/i,
  /^mrp\b/i,
  /^price\b/i,
  /^rs\.?\s*\d/i,
  /^₹/,
  /^www\./i,
  /^https?:/i,
  /copyright/i,
  /all rights reserved/i,
  /printed in/i,
  /published by/i,
  /^edition\b/i,
  /edition$/i,
  /^revised edition\b/i,
  /^new edition\b/i,
  /^contents?$/i,
  /^index$/i,
  /^preface$/i,
  /^acknowledg/i,
  /^email\b/i,
  /^phone\b/i,
  /^mobile\b/i,
  /^मूल्य/,
  /^प्रकाशक/,
  /^संस्करण/,
  /^अनुक्रमणिका/,
  /^विषय\s*सूची/,
  /^सर्वाधिकार/
];

/* Cover par common shabd — inse book identify nahi hoti. */
const PHOTO_GENERIC_TOKENS = new Set([
  "book", "books", "latest", "syllabus", "based", "edition",
  "revised", "publication", "publications", "publisher", "made",
  "simple", "learning", "feature", "features", "author", "authors",
  "prof", "class", "grade", "standard", "part", "volume", "vol",
  "new", "complete", "guide", "textbook", "text", "course",
  "practice", "study", "solution", "solutions", "paper", "papers"
]);

/* ऀ-ॿ = Devanagari block. */
const PHOTO_LETTER_PATTERN = /[A-Za-zऀ-ॿ]/;
const PHOTO_LETTER_GLOBAL = /[A-Za-zऀ-ॿ]/g;

/* ------------------------------------------------------------------ */
/* SHEETS                                                              */
/* ------------------------------------------------------------------ */

function ensureBookImagesSheet_() {
  const spreadsheet = getSpreadsheet_();

  let sheet = spreadsheet.getSheetByName(CONFIG.BOOK_IMAGES_SHEET);

  if (sheet) {
    const firstHeader = String(
      sheet.getRange(1, 1).getValue() || ""
    ).trim();

    if (firstHeader === BOOK_IMAGES_HEADERS[0]) {
      return sheet;
    }

    sheet.setName(
      getUniqueBackupSheetName_(spreadsheet, CONFIG.BOOK_IMAGES_SHEET)
    );
  }

  sheet = spreadsheet.insertSheet(CONFIG.BOOK_IMAGES_SHEET);

  sheet
    .getRange(1, 1, 1, BOOK_IMAGES_HEADERS.length)
    .setValues([BOOK_IMAGES_HEADERS])
    .setFontWeight("bold")
    .setBackground("#2C3A54")
    .setFontColor("#FFFFFF");

  sheet.setFrozenRows(1);

  [150, 340, 260, 260, 170, 80, 260].forEach(function (width, index) {
    sheet.setColumnWidth(index + 1, width);
  });

  sheet.getRange(2, 1).setNote(
    "SKU + Barcode/ISBN bharo to photo se barcode scan hone par " +
    "seedha wahi book milegi.\n" +
    "Front Cover URL bharo to search result me book ki photo dikhegi."
  );

  return sheet;
}

function ensurePhotoSearchHistorySheet_() {
  const spreadsheet = getSpreadsheet_();

  let sheet = spreadsheet.getSheetByName(CONFIG.PHOTO_HISTORY_SHEET);

  if (sheet) {
    const firstHeader = String(
      sheet.getRange(1, 1).getValue() || ""
    ).trim();

    if (firstHeader === PHOTO_HISTORY_HEADERS[0]) {
      return sheet;
    }

    sheet.setName(
      getUniqueBackupSheetName_(spreadsheet, CONFIG.PHOTO_HISTORY_SHEET)
    );
  }

  sheet = spreadsheet.insertSheet(CONFIG.PHOTO_HISTORY_SHEET);

  sheet
    .getRange(1, 1, 1, PHOTO_HISTORY_HEADERS.length)
    .setValues([PHOTO_HISTORY_HEADERS])
    .setFontWeight("bold")
    .setBackground("#2C3A54")
    .setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");

  sheet.setFrozenRows(1);

  return sheet;
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function hasPhotoMetadata_(parameters) {
  if (!parameters) {
    return false;
  }

  const searchType = String(parameters.searchType || "")
    .trim()
    .toLowerCase();

  return searchType === "photo" ||
    Boolean(String(parameters.photoSearchId || "").trim());
}

function cleanPhotoText_(value, maxLength) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  const limit = Number(maxLength) || 5000;

  return text.substring(0, limit);
}

function cleanPhotoNumber_(value) {
  const raw = String(value === null || value === undefined ? "" : value)
    .replace(/,/g, "")
    .trim();

  if (!raw) {
    return "";
  }

  const number = Number(raw);

  return Number.isFinite(number) ? number : "";
}

/**
 * OCR text ko useful lines me todta hai.
 * Hindi lines bhi rakhta hai (V3 sirf Latin letters maangta tha).
 */
function cleanOcrLinesServer_(ocrText) {
  return String(ocrText || "")
    .replace(/\r/g, "\n")
    .replace(/[|¦]/g, "I")
    .split("\n")
    .map(function (line) {
      return line
        .replace(/\s+/g, " ")
        .replace(/^[^A-Za-z0-9ऀ-ॿ]+/, "")
        .replace(/[^A-Za-z0-9ऀ-ॿ]+$/, "")
        .trim();
    })
    .filter(function (line) {
      if (line.length < 3) {
        return false;
      }

      if (!PHOTO_LETTER_PATTERN.test(line)) {
        return false;
      }

      return !PHOTO_NOISE_PATTERNS.some(function (pattern) {
        return pattern.test(line);
      });
    })
    .slice(0, 40);
}

/**
 * Paragraph / instruction line hai? To wo title nahi ho sakti.
 */
function isPhotoParagraphLine_(line) {
  const text = String(line || "").trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length > 12 || text.length > 105) {
    return true;
  }

  if (/\b(how to|perform|access the|register for|understanding|create edit|opening of|using it|finding information|operate the|digital literacy|financial literacy)\b/i.test(text)) {
    return true;
  }

  if (/^[\-–—•▪►]+/.test(text)) {
    return true;
  }

  if ((text.match(/[,.;]/g) || []).length >= 3) {
    return true;
  }

  return false;
}

/**
 * Cover OCR se book ke naam wali lines nikalta hai.
 * Poora OCR paragraph kabhi search query nahi banta.
 */
function extractPhotoTitleCandidates_(ocrText, dictionary) {
  const rawLines = cleanOcrLinesServer_(ocrText).slice(0, 24);
  const candidates = [];

  const rejectPattern = /\b(based on|latest syllabus|nielit|learning features?|word processing|online banking|financial literacy|internet|email|price|isbn|mrp|published|publications?|author|prof\.?|by\s+[a-z])\b/i;

  const subjectPattern = /\b(awareness|concepts?|mathematics|maths?|science|english|hindi|physics|chemistry|biology|computer|accountancy|accounts|economics|history|geography|civics|grammar|entrance|exam|technology|engineering|management|sanskrit|social)\b/i;

  const hindiSubjectPattern = /(गणित|विज्ञान|हिंदी|हिन्दी|अंग्रेज|व्याकरण|इतिहास|भूगोल|अर्थशास्त्र|रसायन|भौतिक|जीव|संस्कृत|कला|नागरिक|सामाजिक|लेखा|कंप्यूटर|शारीरिक|शिक्षा)/;

  function buildCandidate(text, baseScore, lineIndex) {
    const tokens = canonicalTokens_(text, dictionary).filter(function (token) {
      return token.length > 1 || /^\d+$/.test(token);
    });

    /*
     * Normally 2+ words chahiye. Lekin ek hi word bhi chalega
     * agar wo lamba aur distinctive ho — "SARASWATI" ya "विज्ञान"
     * jaisi single-line covers ke liye zaroori hai.
     */
    if (!tokens.length) {
      return null;
    }

    if (tokens.length === 1) {
      const single = tokens[0];

      if (
        single.length < 4 ||
        /^\d+$/.test(single) ||
        PHOTO_GENERIC_TOKENS.has(single)
      ) {
        return null;
      }
    }

    let score = baseScore;

    const words = text.split(/\s+/).filter(Boolean);

    if (words.length >= 2 && words.length <= 8) {
      score += 25;
    }

    if (text.length >= 8 && text.length <= 70) {
      score += 18;
    }

    if (/^[A-Z0-9 &:'\-]+$/.test(text)) {
      score += 15;
    }

    if (subjectPattern.test(text) || hindiSubjectPattern.test(text)) {
      score += 20;
    }

    /* Distinctive words zyada = better title. */
    const distinctive = tokens.filter(function (token) {
      return token.length >= 3 && !PHOTO_GENERIC_TOKENS.has(token);
    }).length;

    score += Math.min(12, distinctive * 4);

    /* OCR garbage wali lines kamzor candidate hain. */
    const letterCount = (text.match(PHOTO_LETTER_GLOBAL) || []).length;

    if (letterCount / Math.max(1, text.length) < 0.55) {
      score -= 25;
    }

    return {
      text: text,
      canonical: tokens.join(" "),
      tokens: tokens,
      phonetics: phoneticKeys_(tokens),
      distinctive: distinctive,
      score: Math.round(score),
      lineIndex: lineIndex
    };
  }

  rawLines.forEach(function (line, index) {
    const text = String(line || "").trim();

    if (!text || isPhotoParagraphLine_(text) || rejectPattern.test(text)) {
      return;
    }

    /* Title cover me upar hota hai. */
    const positionScore = Math.max(0, 24 - index * 1.5);
    const candidate = buildCandidate(text, positionScore, index);

    if (candidate) {
      candidates.push(candidate);
    }
  });

  /*
   * Do chhoti lines jod kar bhi dekhte hain —
   * "SAINIK SCHOOL" + "ENTRANCE EXAM" = ek title.
   */
  for (let index = 0; index < rawLines.length - 1; index++) {
    const first = String(rawLines[index] || "").trim();
    const second = String(rawLines[index + 1] || "").trim();

    if (
      !first ||
      !second ||
      isPhotoParagraphLine_(first) ||
      isPhotoParagraphLine_(second)
    ) {
      continue;
    }

    const combined = (first + " " + second).replace(/\s+/g, " ").trim();

    if (combined.length > 110 || rejectPattern.test(combined)) {
      continue;
    }

    const candidate = buildCandidate(combined, 30 - index, index);

    if (candidate && candidate.tokens.length >= 2 && candidate.tokens.length <= 12) {
      candidates.push(candidate);
    }
  }

  /* Same canonical ka sabse achha version rakho. */
  const unique = {};

  candidates.forEach(function (candidate) {
    if (!candidate.canonical) {
      return;
    }

    if (
      !unique[candidate.canonical] ||
      unique[candidate.canonical].score < candidate.score
    ) {
      unique[candidate.canonical] = candidate;
    }
  });

  return Object.keys(unique)
    .map(function (key) {
      return unique[key];
    })
    .sort(function (first, second) {
      return second.score - first.score;
    })
    .slice(0, 12);
}

/**
 * Ek candidate title aur ek book kitna match karte hain.
 * null = evidence kaafi nahi.
 */
function calculateCandidateToBookScore_(candidate, book) {
  const titleTokens = book.nameTokens.filter(function (token) {
    return token.length > 1 || /^\d+$/.test(token);
  });

  if (!titleTokens.length || !candidate.tokens.length) {
    return null;
  }

  const candidateSet = new Set(candidate.tokens);

  let matched = 0;
  let distinctiveMatched = 0;
  let weightedMatched = 0;
  let weightedTotal = 0;

  titleTokens.forEach(function (titleToken, titleIndex) {
    const generic = PHOTO_GENERIC_TOKENS.has(titleToken);
    const weight = generic ? 0.25 : 1;

    let best = candidateSet.has(titleToken) ? 100 : 0;

    if (!best) {
      const titlePhonetic = book.namePhonetics[titleIndex];

      for (let index = 0; index < candidate.tokens.length; index++) {
        const score = tokenSimilarity_(
          candidate.tokens[index],
          candidate.phonetics[index],
          titleToken,
          titlePhonetic
        );

        if (score > best) {
          best = score;

          if (best === 100) {
            break;
          }
        }
      }
    }

    weightedTotal += weight;

    if (best >= 80) {
      matched++;
      weightedMatched += weight * (best / 100);

      if (!generic && titleToken.length >= 3) {
        distinctiveMatched++;
      }
    }
  });

  const titleCoverage = matched / titleTokens.length;
  const weightedCoverage = weightedTotal ? weightedMatched / weightedTotal : 0;

  const exactPhrase = Boolean(candidate.canonical) &&
    Boolean(book.nameCanonical) && (
      candidate.canonical === book.nameCanonical ||
      candidate.canonical.indexOf(book.nameCanonical) !== -1 ||
      book.nameCanonical.indexOf(candidate.canonical) !== -1
    );

  /*
   * Sakht evidence rule:
   * ya to poora title match ho, ya 2 distinctive words +
   * achha coverage. Isse "account" jaise ek shabd par
   * Accountancy-12 galat nahi aati.
   */
  if (
    !exactPhrase &&
    !(distinctiveMatched >= 2 && titleCoverage >= 0.6 && weightedCoverage >= 0.68)
  ) {
    return null;
  }

  let score = weightedCoverage * 72 + titleCoverage * 18;

  if (exactPhrase) {
    score += 18;
  }

  score += Math.min(8, distinctiveMatched * 2);

  return {
    score: Math.min(100, Math.round(score)),
    titleCoverage: titleCoverage,
    distinctiveMatched: distinctiveMatched,
    exactPhrase: exactPhrase
  };
}

/**
 * Sabhi candidates ko inventory se match karke best book deta hai.
 */
function findInventoryTitleFromCandidates_(candidates, dictionary) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return null;
  }

  const indexedBooks = getSearchIndex_(dictionary);
  let best = null;

  candidates.forEach(function (candidate) {
    indexedBooks.forEach(function (book) {
      const evaluation = calculateCandidateToBookScore_(candidate, book);

      if (!evaluation) {
        return;
      }

      /* Candidate ki quality ka thoda supporting bonus. */
      const finalScore = Math.min(
        100,
        evaluation.score + Math.max(0, Math.min(5, candidate.score / 20))
      );

      if (!best || finalScore > best.score) {
        best = {
          sku: book.sku,
          name: book.name,
          category: book.category,
          source: book.source,
          sources: book.sources,
          score: Math.round(finalScore),
          candidateText: candidate.text,
          titleCoverage: evaluation.titleCoverage,
          distinctiveMatches: evaluation.distinctiveMatched,
          exactPhrase: evaluation.exactPhrase
        };
      }
    });
  });

  return best && best.score >= 76 ? best : null;
}

/**
 * Barcode / ISBN se book dhoondhna.
 *
 * Pehla source: Book Images sheet ka Barcode/ISBN column.
 * Doosra source: SKU ya Item Name me wahi digits.
 */
function findBookByBarcodeValue_(barcodeValue, dictionary) {
  const raw = String(barcodeValue || "").trim();

  if (!raw) {
    return null;
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length < 8) {
    return null;
  }

  const media = safeGetBookMediaMap_();
  const indexedBooks = getSearchIndex_(dictionary);

  const registeredSku = media.barcodeToSku[digits] || "";

  if (registeredSku) {
    const normalizedSku = basicNormalize_(registeredSku);

    for (let index = 0; index < indexedBooks.length; index++) {
      if (basicNormalize_(indexedBooks[index].sku) === normalizedSku) {
        return {
          book: indexedBooks[index],
          via: "Book Images sheet"
        };
      }
    }
  }

  /* EAN-13 me pehla ISBN-10/13 hissa bhi try karo. */
  const variants = [digits];

  if (digits.length === 13) {
    variants.push(digits.substring(3));
  }

  for (let index = 0; index < indexedBooks.length; index++) {
    const book = indexedBooks[index];
    const haystack = (book.sku + " " + book.name).replace(/\D/g, "");

    for (let v = 0; v < variants.length; v++) {
      if (variants[v].length >= 8 && haystack.indexOf(variants[v]) !== -1) {
        return {
          book: book,
          via: "SKU / Item Name"
        };
      }
    }
  }

  return null;
}

/**
 * Main photo analyzer.
 *
 * Return me sabse important field: searchQuery.
 * Wo hamesha ek book ka NAAM hoti hai, barcode digits kabhi nahi.
 */
function analyzePhotoSearch_(parameters, fallbackQuery) {
  const dictionary = getTrainingDictionary_();
  const safeParameters = parameters || {};

  const ocrText = cleanPhotoText_(safeParameters.ocrText, 10000);
  const barcode = cleanPhotoText_(safeParameters.barcode, 250);

  const candidates = extractPhotoTitleCandidates_(ocrText, dictionary);
  const inventoryMatch = findInventoryTitleFromCandidates_(candidates, dictionary);

  let barcodeMatch = null;

  if (barcode) {
    try {
      barcodeMatch = findBookByBarcodeValue_(barcode, dictionary);
    } catch (error) {
      console.warn("Barcode lookup failed:", error);
    }
  }

  const bestTitleLine = candidates.length && candidates[0].score >= 40
    ? candidates[0].text
    : "";

  let extractedTitle = "";
  let searchQuery = "";
  let method = "fallback";
  let confidence = 0;

  if (barcodeMatch) {
    /* Sabse pakka case — barcode registered hai. */
    extractedTitle = barcodeMatch.book.name;
    searchQuery = barcodeMatch.book.name;
    method = "barcode-match (" + barcodeMatch.via + ")";
    confidence = 97;

  } else if (inventoryMatch) {
    extractedTitle = inventoryMatch.name;
    searchQuery = inventoryMatch.name;
    method = "title-match";
    confidence = inventoryMatch.score;

  } else if (bestTitleLine) {
    /*
     * Inventory me pakka match nahi mila. Top 3 title lines se
     * multi-search karo — kuch milta julta to zaroor milega.
     */
    extractedTitle = bestTitleLine;

    searchQuery = candidates
      .slice(0, 3)
      .map(function (candidate) {
        return candidate.text;
      })
      .join("\n");

    method = candidates.length > 1 ? "multi-title-search" : "title-line";
    confidence = Math.max(45, Math.min(72, candidates[0].score));

  } else {
    searchQuery = cleanPhotoText_(fallbackQuery, CONFIG.MAX_QUERY_LENGTH);
    extractedTitle = searchQuery;
    method = "fallback";
    confidence = 0;
  }

  return {
    extractedTitle: extractedTitle,
    searchQuery: searchQuery,
    method: method,
    confidence: Math.round(confidence),

    barcode: barcode,
    barcodeMatched: Boolean(barcodeMatch),
    barcodeMessage: barcode && !barcodeMatch
      ? "Barcode mila lekin data me registered nahi hai. " +
        "Book Images sheet me is barcode ke saath SKU add kar sakte ho."
      : "",

    matchedSku: barcodeMatch
      ? barcodeMatch.book.sku
      : inventoryMatch ? inventoryMatch.sku : "",

    matchedSources: barcodeMatch
      ? barcodeMatch.book.sources
      : inventoryMatch ? inventoryMatch.sources : [],

    candidateTitles: candidates.slice(0, 5).map(function (candidate) {
      return candidate.text;
    })
  };
}

/* ------------------------------------------------------------------ */
/* PHOTO HISTORY LOG                                                   */
/* ------------------------------------------------------------------ */

function getTopPhotoResult_(searchResults, parameters) {
  const groups = Array.isArray(searchResults) ? searchResults : [];

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const matches = Array.isArray(groups[groupIndex].matches)
      ? groups[groupIndex].matches
      : [];

    if (matches.length) {
      return matches[0];
    }
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const similar = Array.isArray(groups[groupIndex].similar)
      ? groups[groupIndex].similar
      : [];

    if (similar.length) {
      return similar[0];
    }
  }

  const suppliedTopSku = cleanPhotoText_(parameters.topSku, 200);
  const suppliedTopItem = cleanPhotoText_(parameters.topItem, 500);

  if (suppliedTopSku || suppliedTopItem) {
    return {
      sku: suppliedTopSku,
      name: suppliedTopItem,
      category: cleanPhotoText_(parameters.topCategory, 300),
      closingStock: cleanPhotoText_(parameters.topClosingStock, 200),
      source: cleanPhotoText_(parameters.topSource, 200),
      score: cleanPhotoNumber_(parameters.topScore)
    };
  }

  return null;
}

function countPhotoResults_(searchResults, parameters) {
  const groups = Array.isArray(searchResults) ? searchResults : [];

  if (groups.length) {
    return groups.reduce(function (total, group) {
      return total + (Array.isArray(group.matches) ? group.matches.length : 0);
    }, 0);
  }

  const suppliedCount = cleanPhotoNumber_(parameters.resultCount);

  return suppliedCount === "" ? 0 : suppliedCount;
}

function logPhotoSearchDecision_(
  parameters,
  searchResults,
  userDecision,
  feedbackDetails
) {
  const safeParameters = parameters || {};
  const feedback = feedbackDetails || {};

  const sheet = getCachedSheet_(
    CONFIG.PHOTO_HISTORY_SHEET,
    ensurePhotoSearchHistorySheet_
  );

  const now = new Date();

  const topResult = getTopPhotoResult_(searchResults, safeParameters);
  const resultCount = countPhotoResults_(searchResults, safeParameters);

  const finalQuery = cleanPhotoText_(
    safeParameters.finalQuery ||
      safeParameters.q ||
      safeParameters.searchText,
    CONFIG.MAX_QUERY_LENGTH
  );

  const row = [
    now,
    cleanPhotoText_(safeParameters.photoSearchId, 220),
    cleanPhotoText_(safeParameters.photoFileName, 300),
    cleanPhotoText_(safeParameters.photoFileType, 150),
    cleanPhotoNumber_(safeParameters.photoFileSize),
    cleanPhotoNumber_(safeParameters.photoWidth),
    cleanPhotoNumber_(safeParameters.photoHeight),
    cleanPhotoText_(safeParameters.ocrText, 10000),
    cleanPhotoText_(safeParameters.barcode, 250),
    finalQuery,
    resultCount > 0 ? "Matched" : "No Match",
    resultCount,
    topResult ? cleanPhotoText_(topResult.sku, 200) : "",
    topResult ? cleanPhotoText_(topResult.name, 500) : "",
    topResult ? cleanPhotoText_(topResult.category, 300) : "",
    topResult ? normalizeTrendNumber_(topResult.closingStock) : "",
    topResult ? cleanPhotoText_(topResult.source, 200) : "",
    topResult ? normalizeTrendScore_(topResult.score) : "",
    cleanPhotoText_(userDecision, 40),
    cleanPhotoText_(feedback.expectedBook, 500),
    cleanPhotoText_(feedback.expectedSku, 200),
    cleanPhotoText_(
      feedback.remarks || safeParameters.photoRemarks,
      500
    )
  ];

  sheet.appendRow(row);

  const rowNumber = sheet.getLastRow();

  sheet.getRange(rowNumber, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
  sheet.getRange(rowNumber, 18).setNumberFormat('0"%"');

  return {
    success: true,
    row: rowNumber,
    searchId: row[1]
  };
}
