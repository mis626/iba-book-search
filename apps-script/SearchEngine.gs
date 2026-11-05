/**
 * IBA Smart Book Search — V4
 * File: SearchEngine.gs   (purani SearchEngine.gs ko poori replace karo)
 *
 * Ye file decide karti hai ki kaunsi book kitni match hui.
 *
 * Matching ki 5 layers (score ke saath):
 *   100  exact token
 *    93  query token, book token ka starting hissa hai
 *    89  ulta — book token, query token ka starting hissa
 *    85  ek letter ka farq (Levenshtein 1)
 *    80  phonetic match — kitab/kitaab, vyakaran/vyakran, vigyan/विज्ञान
 *    78  do letter ka farq (sirf lambe words me)
 *
 * Do list banti hain:
 *   matches  = pakke result   (score >= CONFIG.STRONG_SCORE_CUTOFF)
 *   similar  = milte julte    (score >= CONFIG.SIMILAR_SCORE_CUTOFF)
 */

/*
 * Ye shabd bahut si books me aate hain, isliye inka match
 * "distinctive" nahi maana jaata.
 */
const IBA_GENERIC_TOKENS = new Set([
  "new", "latest", "complete", "guide", "part", "vol", "volume",
  "simple", "easy", "study", "practice", "question", "answer",
  "chapter", "course", "based", "syllabus", "series", "set",
  "edu", "book", "paper", "solution", "solutions", "sample",
  "term", "semester", "level", "junior", "senior", "basic"
]);

/* ------------------------------------------------------------------ */
/* TOKEN MATCHING                                                      */
/* ------------------------------------------------------------------ */

/**
 * Do tokens kitne milte hain — 0 se 100.
 */
function tokenSimilarity_(
  queryToken,
  queryPhonetic,
  targetToken,
  targetPhonetic
) {
  if (!queryToken || !targetToken) {
    return 0;
  }

  if (queryToken === targetToken) {
    return 100;
  }

  const queryIsNumber = /^\d+$/.test(queryToken);
  const targetIsNumber = /^\d+$/.test(targetToken);

  /*
   * Number me koi fuzzy matching nahi.
   * Class 10 ki book, class 11 ki book se match nahi honi chahiye.
   */
  if (queryIsNumber || targetIsNumber) {
    return 0;
  }

  if (queryToken.length >= 4 && targetToken.indexOf(queryToken) === 0) {
    return 93;
  }

  if (targetToken.length >= 4 && queryToken.indexOf(targetToken) === 0) {
    return 89;
  }

  const distance = levenshteinDistance_(queryToken, targetToken);

  if (queryToken.length >= 5 && distance === 1) {
    return 85;
  }

  /*
   * Phonetic layer — Hindi/English spelling ke farq ke liye.
   * Sirf 4+ letter tokens par, warna chhote words galat match karte hain.
   */
  if (
    queryToken.length >= 4 &&
    targetToken.length >= 4 &&
    queryPhonetic &&
    targetPhonetic &&
    queryPhonetic === targetPhonetic
  ) {
    return 80;
  }

  if (queryToken.length >= 8 && distance === 2) {
    return 78;
  }

  return 0;
}

/**
 * Ek query token ka book ke andar sabse accha match.
 */
function bestTokenMatch_(queryToken, queryPhonetic, book) {
  let bestScore = 0;
  let bestField = "";

  const fields = [
    ["sku", book.skuTokens, book.skuPhonetics],
    ["name", book.nameTokens, book.namePhonetics],
    ["category", book.categoryTokens, book.categoryPhonetics]
  ];

  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
    const fieldName = fields[fieldIndex][0];
    const tokens = fields[fieldIndex][1];
    const phonetics = fields[fieldIndex][2];

    for (let index = 0; index < tokens.length; index++) {
      const score = tokenSimilarity_(
        queryToken,
        queryPhonetic,
        tokens[index],
        phonetics[index]
      );

      if (score > bestScore) {
        bestScore = score;
        bestField = fieldName;

        if (bestScore === 100) {
          return { score: 100, field: fieldName };
        }
      }
    }
  }

  return {
    score: bestScore,
    field: bestField
  };
}

/* ------------------------------------------------------------------ */
/* INDEX                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ek hi book agar do ya teen sheets me hai to ek card banta hai,
 * aur uska stock source-wise dikhta hai.
 *
 * V4 me closingStock number hi rehta hai (Trend/Looker ke liye),
 * aur dikhane ke liye alag stockLabel banta hai.
 */
function mergeDuplicateBooks_(books) {
  const merged = [];
  const indexByKey = {};

  (Array.isArray(books) ? books : []).forEach(function (book) {
    const normalizedSku = basicNormalize_(book.sku);
    const normalizedName = basicNormalize_(book.name);

    if (!normalizedSku && !normalizedName) {
      return;
    }

    const key = normalizedSku
      ? "SKU|" + normalizedSku
      : "NAME|" + normalizedName;

    if (indexByKey[key] === undefined) {
      indexByKey[key] = merged.length;

      merged.push({
        sku: book.sku,
        name: book.name,
        category: book.category,
        source: book.source,
        sources: [book.source],
        stockBySource: [{
          source: book.source,
          closingStock: book.closingStock
        }],
        closingStock: book.closingStock
      });

      return;
    }

    const existing = merged[indexByKey[key]];

    if (existing.sources.indexOf(book.source) === -1) {
      existing.sources.push(book.source);
    }

    existing.stockBySource.push({
      source: book.source,
      closingStock: book.closingStock
    });

    existing.closingStock += book.closingStock;

    if (!existing.category && book.category) {
      existing.category = book.category;
    }

    if (!existing.name && book.name) {
      existing.name = book.name;
    }

    existing.source = existing.sources.join(", ");
  });

  merged.forEach(function (book) {
    book.stockLabel = book.stockBySource.length > 1
      ? book.stockBySource
          .map(function (item) {
            return item.source + ": " + item.closingStock;
          })
          .join("  |  ") +
        "  =  " + book.closingStock
      : String(book.closingStock);
  });

  return merged;
}

/**
 * Searchable index. Ye mehnga kaam hai, isliye Code.gs ka
 * getSearchIndex_() isko ek execution me ek hi baar chalata hai.
 */
function buildBookSearchIndex_(books, dictionary) {
  const mergedBooks = mergeDuplicateBooks_(books);
  const media = safeGetBookMediaMap_();

  return mergedBooks.map(function (book) {
    const skuTokens = canonicalTokens_(book.sku, dictionary);
    const nameTokens = canonicalTokens_(book.name, dictionary);
    const categoryTokens = canonicalTokens_(book.category, dictionary);

    return {
      sku: book.sku,
      name: book.name,
      category: book.category,
      source: book.source,
      sources: book.sources,
      closingStock: book.closingStock,
      stockLabel: book.stockLabel,
      stockBySource: book.stockBySource,
      imageUrl: media.images[basicNormalize_(book.sku)] || "",

      skuTokens: skuTokens,
      nameTokens: nameTokens,
      categoryTokens: categoryTokens,

      skuPhonetics: phoneticKeys_(skuTokens),
      namePhonetics: phoneticKeys_(nameTokens),
      categoryPhonetics: phoneticKeys_(categoryTokens),

      skuCanonical: skuTokens.join(" "),
      nameCanonical: nameTokens.join(" "),
      categoryCanonical: categoryTokens.join(" ")
    };
  });
}

/**
 * Query ko ek baar process karke reuse karta hai.
 */
function buildQueryInfo_(query, dictionary) {
  const tokens = canonicalTokens_(query, dictionary);

  return {
    raw: String(query || "").trim(),
    tokens: tokens,
    phonetics: phoneticKeys_(tokens),
    canonical: tokens.join(" "),

    /*
     * Words ka order hata kar banaya gaya key.
     * "ganit 12" aur "12 math" — dono ka same sortedCanonical,
     * isliye approved feedback rule dono par lagta hai.
     */
    sortedCanonical: tokens.slice().sort().join(" ")
  };
}

/* ------------------------------------------------------------------ */
/* SCORING                                                            */
/* ------------------------------------------------------------------ */

/**
 * Ek book ka score nikalta hai.
 * null matlab bilkul match nahi.
 */
function scoreBookAgainstQuery_(queryInfo, book) {
  const queryTokens = queryInfo.tokens;

  if (!queryTokens.length) {
    return null;
  }

  const canonicalQuery = queryInfo.canonical;

  /* Exact match ke shortcuts. */
  if (book.skuCanonical && book.skuCanonical === canonicalQuery) {
    return { score: 100, coverage: 1, distinctive: 9, matchedOn: "SKU exact" };
  }

  if (book.nameCanonical && book.nameCanonical === canonicalQuery) {
    return { score: 100, coverage: 1, distinctive: 9, matchedOn: "Name exact" };
  }

  if (book.categoryCanonical && book.categoryCanonical === canonicalQuery) {
    return { score: 96, coverage: 1, distinctive: 5, matchedOn: "Category exact" };
  }

  let matchedCount = 0;
  let totalScore = 0;
  let distinctive = 0;

  const fieldHits = { sku: 0, name: 0, category: 0 };

  for (let index = 0; index < queryTokens.length; index++) {
    const queryToken = queryTokens[index];

    const match = bestTokenMatch_(
      queryToken,
      queryInfo.phonetics[index],
      book
    );

    if (match.score >= 78) {
      matchedCount++;
      totalScore += match.score;

      if (fieldHits[match.field] !== undefined) {
        fieldHits[match.field]++;
      }

      if (queryToken.length >= 3 && !IBA_GENERIC_TOKENS.has(queryToken)) {
        distinctive++;
      }
    }
  }

  if (!matchedCount) {
    return null;
  }

  const coverage = matchedCount / queryTokens.length;

  /* Unmatched tokens ka penalty is division me automatic hai. */
  let score = totalScore / queryTokens.length;

  /* Phrase containment bonus. */
  if (canonicalQuery && book.nameCanonical.indexOf(canonicalQuery) !== -1) {
    score += 7;
  }

  if (book.nameCanonical && canonicalQuery.indexOf(book.nameCanonical) !== -1) {
    score += 5;
  }

  if (canonicalQuery && book.skuCanonical.indexOf(canonicalQuery) !== -1) {
    score += 7;
  }

  if (canonicalQuery && book.categoryCanonical.indexOf(canonicalQuery) !== -1) {
    score += 3;
  }

  /* Poora field match hua to bonus. */
  if (fieldHits.sku === queryTokens.length) {
    score += 5;
  }

  if (fieldHits.name === queryTokens.length) {
    score += 3;
  }

  /*
   * Precision bonus — chhote naam wali book jisme query ka
   * bada hissa match hua, wo zyada relevant hai.
   */
  const nameTokenCount = book.nameTokens.length || 1;
  const precision = Math.min(1, matchedCount / nameTokenCount);

  score += precision * 5;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    coverage: coverage,
    distinctive: distinctive,
    matchedOn: matchedCount + "/" + queryTokens.length + " words"
  };
}

/**
 * Query ki length ke hisaab se kitna coverage zaroori hai.
 * Chhoti query sakht, lambi (photo/OCR) query narm.
 */
function getRequiredCoverage_(tokenCount) {
  if (tokenCount <= 2) {
    return 1;
  }

  if (tokenCount <= 4) {
    return 0.75;
  }

  if (tokenCount <= 8) {
    return 0.6;
  }

  return 0.5;
}

/* ------------------------------------------------------------------ */
/* MAIN SEARCH                                                        */
/* ------------------------------------------------------------------ */

/**
 * Approved feedback rule query se match hota hai?
 * Exact normalized text ya 75% token overlap — dono chalega.
 */
function matchApprovedRule_(queryInfo, feedbackRules) {
  if (!Array.isArray(feedbackRules) || !feedbackRules.length) {
    return null;
  }

  if (!queryInfo.tokens.length) {
    return null;
  }

  const queryTokenSet = new Set(queryInfo.tokens);
  let best = null;

  feedbackRules.forEach(function (rule) {
    if (!rule.sku || !rule.tokens.length) {
      return;
    }

    /* Exact normalized match = sabse strong (word order matter nahi karta). */
    const ruleSorted = rule.sortedCanonical ||
      rule.tokens.slice().sort().join(" ");

    if (
      (rule.canonical && rule.canonical === queryInfo.canonical) ||
      (ruleSorted && ruleSorted === queryInfo.sortedCanonical)
    ) {
      if (!best || best.overlap < 2) {
        best = { rule: rule, overlap: 2 };
      }
      return;
    }

    let common = 0;

    rule.tokens.forEach(function (token) {
      if (queryTokenSet.has(token)) {
        common++;
      }
    });

    const overlap = common /
      Math.max(rule.tokens.length, queryInfo.tokens.length);

    if (overlap >= 0.75 && (!best || overlap > best.overlap)) {
      best = { rule: rule, overlap: overlap };
    }
  });

  return best ? best.rule : null;
}

/**
 * Search ka main function.
 *
 * Return:
 * {
 *   matches: [...]  pakke result
 *   similar: [...]  milte julte result
 *   approvedPin: { sku, name } | null
 * }
 */
function findRelevantBooks_(query, indexedBooks, dictionary, feedbackRules) {
  const queryInfo = buildQueryInfo_(query, dictionary);

  if (!queryInfo.tokens.length) {
    return {
      matches: [],
      similar: [],
      approvedPin: null
    };
  }

  const approvedRule = matchApprovedRule_(queryInfo, feedbackRules);

  const pinnedSku = approvedRule
    ? basicNormalize_(approvedRule.sku)
    : "";

  const requiredCoverage = getRequiredCoverage_(queryInfo.tokens.length);

  const scored = [];

  indexedBooks.forEach(function (book) {
    const evaluation = scoreBookAgainstQuery_(queryInfo, book);
    const isPinned = Boolean(pinnedSku) &&
      basicNormalize_(book.sku) === pinnedSku;

    if (!evaluation && !isPinned) {
      return;
    }

    const base = evaluation || {
      score: 0,
      coverage: 1,
      distinctive: 1,
      matchedOn: "approved feedback"
    };

    scored.push({
      sku: book.sku,
      name: book.name,
      category: book.category,
      closingStock: book.closingStock,
      stockLabel: book.stockLabel,
      stockBySource: book.stockBySource,
      source: book.source,
      sources: book.sources,
      imageUrl: book.imageUrl,
      score: isPinned ? 100 : base.score,
      coverage: base.coverage,
      distinctive: base.distinctive,
      matchedOn: isPinned ? "Approved feedback" : base.matchedOn,
      feedbackPreferred: isPinned,
      resultType: "strong"
    });
  });

  const strong = [];
  const similar = [];

  scored.forEach(function (item) {
    if (item.feedbackPreferred) {
      strong.push(item);
      return;
    }

    if (
      item.score >= CONFIG.STRONG_SCORE_CUTOFF &&
      item.coverage >= requiredCoverage
    ) {
      strong.push(item);
      return;
    }

    if (
      item.score >= CONFIG.SIMILAR_SCORE_CUTOFF &&
      item.distinctive >= 1
    ) {
      item.resultType = "similar";
      similar.push(item);
    }
  });

  const sorter = function (first, second) {
    if (first.feedbackPreferred !== second.feedbackPreferred) {
      return first.feedbackPreferred ? -1 : 1;
    }

    if (second.score !== first.score) {
      return second.score - first.score;
    }

    if (second.closingStock !== first.closingStock) {
      return second.closingStock - first.closingStock;
    }

    return String(first.name).localeCompare(String(second.name));
  };

  strong.sort(sorter);
  similar.sort(sorter);

  /*
   * Safety net: kuch bhi na mile to sabse kareeb ke result
   * "similar" me dikha do. User ko khali screen kabhi na mile.
   */
  let finalSimilar = similar.slice(0, CONFIG.MAX_SIMILAR_RESULTS);

  if (!strong.length && !finalSimilar.length) {
    finalSimilar = scored
      .filter(function (item) {
        return item.score >= 30 && item.distinctive >= 1;
      })
      .sort(sorter)
      .slice(0, 5)
      .map(function (item) {
        item.resultType = "similar";
        return item;
      });
  }

  return {
    matches: strong.slice(0, CONFIG.MAX_RESULTS),
    similar: finalSimilar,
    approvedPin: approvedRule
      ? { sku: approvedRule.sku, matchedFrom: approvedRule.canonical }
      : null
  };
}

/**
 * SKU se book dhoondhna.
 */
function findBookBySku_(skuValue, books) {
  const sku = basicNormalize_(skuValue);

  if (!sku) {
    return null;
  }

  const list = Array.isArray(books) ? books : [];

  for (let index = 0; index < list.length; index++) {
    if (basicNormalize_(list[index].sku) === sku) {
      return list[index];
    }
  }

  return null;
}
