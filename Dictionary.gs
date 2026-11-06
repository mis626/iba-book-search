/**
 * IBA Smart Book Search — V4
 * File: Dictionary.gs
 *
 * Ye file poore system ki "language layer" hai:
 *   basicNormalize_    -> raw text ko saaf karta hai (Hindi bhi)
 *   applyTrainingDict_ -> Dictionary sheet ke alias apply karta hai
 *   canonicalTokens_   -> final searchable tokens banata hai
 *
 * V3 se do bade farq:
 * 1. Dictionary apply ab regex se nahi, n-gram lookup se hota hai.
 *    V3 me har call par ~150 RegExp banate the. Ab zero RegExp.
 * 2. Sheet ka data kabhi delete nahi hota. Header galat mile to
 *    purani sheet backup naam se rename hoti hai.
 */

const DICTIONARY_HEADERS = [
  "Alias",
  "Canonical Keyword",
  "Related Terms",
  "Active",
  "Remarks"
];

/*
 * Ye shabd search me matter nahi karte, isliye hata diye jaate hain.
 */
const SEARCH_STOP_WORDS = new Set([
  "book", "books", "textbook", "textbooks", "text",
  "please", "chahiye", "chaiye", "chahiyee", "dedo", "do",
  "find", "search", "show", "give", "me", "mujhe", "koi",
  "wala", "wali", "wale", "ka", "ki", "ke", "hai", "he",
  "the", "a", "an", "and", "or", "for", "of", "in", "on",
  "edition", "revised", "latest", "price", "mrp", "rs",
  "isbn", "published", "publisher", "publication", "publications",
  "class", "std", "standard", "grade"
]);

/*
 * Static synonyms — Dictionary sheet ke bina bhi ye kaam karte hain.
 * Hindi shabd Language.gs ke concept map me hain.
 */
const SEARCH_STATIC_SYNONYMS = {
  "education": "edu",
  "educational": "edu",
  "eduction": "edu",
  "educaton": "edu",
  "mathematics": "math",
  "mathematic": "math",
  "maths": "math",
  "sciences": "sci",
  "science": "sci",
  "computers": "computer",
  "computor": "computer",
  "application": "app",
  "applications": "app",
  "phisics": "physics",
  "physic": "physics",
  "chemestry": "chemistry",
  "biolgy": "biology",
  "economics": "eco",
  "economic": "eco",
  "economy": "eco",
  "accountancy": "accounts",
  "accounting": "accounts",
  "account": "accounts",
  "geograpy": "geo",
  "geography": "geo",
  "volume": "vol",
  "pt": "part"
};

/* Execution ke andar dobara kaam na ho, iske liye cache. */
var IBA_DICTIONARY_CACHE = null;
var IBA_COMPILED_DICTIONARY = null;
var IBA_TOKEN_CACHE = {};
var IBA_TOKEN_CACHE_COUNT = 0;
var IBA_CONCEPT_LOOKUP = null;

const IBA_TOKEN_CACHE_LIMIT = 60000;

/* ------------------------------------------------------------------ */
/* NORMALIZATION                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sabse base function. Har text isse hokar guzarta hai.
 *
 * Kaam:
 * - Hindi (Devanagari) ko Latin me badalna
 * - "twelfth", "12th", "class 12" — sabko "12" banana
 * - special characters hatana
 */
/*
 * V3 me yahan ~40 alag regex chalte the. 5000 books par ye
 * lakhon regex operations ban jaate the. Ab sab ek hi pass me.
 */
const IBA_WORD_NUMBERS = {
  "first": "1", "second": "2", "third": "3", "fourth": "4",
  "fifth": "5", "sixth": "6", "seventh": "7", "eighth": "8",
  "ninth": "9", "tenth": "10", "eleventh": "11", "twelfth": "12",

  "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
  "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
  "eleven": "11", "twelve": "12",

  /* Hindi counting. */
  "ek": "1", "teen": "3", "chaar": "4", "panch": "5",
  "paanch": "5", "chah": "6", "saat": "7", "aath": "8",
  "nau": "9", "das": "10", "gyarah": "11", "barah": "12"
};

const IBA_WORD_NUMBER_PATTERN = new RegExp(
  "\\b(" + Object.keys(IBA_WORD_NUMBERS).join("|") + ")\\b",
  "g"
);

const IBA_CLASS_PREFIX_PATTERN =
  /\b(?:class|kaksha|std|standard|grade|shreni)\s*(\d+)\b/g;

const IBA_ORDINAL_PATTERN = /\b(\d+)(?:st|nd|rd|th)\b/g;

var IBA_NORMALIZE_CACHE = {};
var IBA_NORMALIZE_CACHE_COUNT = 0;
const IBA_NORMALIZE_CACHE_LIMIT = 40000;

function basicNormalize_(value) {
  const original = String(value === null || value === undefined ? "" : value);

  if (!original) {
    return "";
  }

  if (IBA_NORMALIZE_CACHE[original] !== undefined) {
    return IBA_NORMALIZE_CACHE[original];
  }

  let text = original;

  if (hasDevanagari_(text)) {
    text = transliterateDevanagari_(text);
  }

  const result = text
    .toLowerCase()
    .replace(IBA_WORD_NUMBER_PATTERN, function (match) {
      return IBA_WORD_NUMBERS[match];
    })
    .replace(IBA_ORDINAL_PATTERN, "$1")
    .replace(IBA_CLASS_PREFIX_PATTERN, "$1")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (IBA_NORMALIZE_CACHE_COUNT < IBA_NORMALIZE_CACHE_LIMIT) {
    IBA_NORMALIZE_CACHE[original] = result;
    IBA_NORMALIZE_CACHE_COUNT++;
  }

  return result;
}

/**
 * Concept map ka reverse index (exact + phonetic).
 * Ek hi baar banta hai.
 */
function getConceptLookup_() {
  if (IBA_CONCEPT_LOOKUP) {
    return IBA_CONCEPT_LOOKUP;
  }

  const exact = {};
  const phonetic = {};
  const buckets = {};

  const sources = [
    IBA_HINDI_ENGLISH_CONCEPTS,
    SEARCH_STATIC_SYNONYMS
  ];

  sources.forEach(function (source) {
    Object.keys(source).forEach(function (key) {
      const canonical = source[key];

      if (!key || !canonical) {
        return;
      }

      exact[key] = canonical;

      if (key.length >= 5) {
        const phoneticKey = phoneticKey_(key);

        if (phoneticKey && phonetic[phoneticKey] === undefined) {
          phonetic[phoneticKey] = canonical;
        }
      }

      const firstCharacter = key.charAt(0);

      if (!buckets[firstCharacter]) {
        buckets[firstCharacter] = [];
      }

      buckets[firstCharacter].push(key);
    });
  });

  IBA_CONCEPT_LOOKUP = {
    exact: exact,
    phonetic: phonetic,
    buckets: buckets
  };

  return IBA_CONCEPT_LOOKUP;
}

function levenshteinDistance_(firstValue, secondValue) {
  const first = String(firstValue || "");
  const second = String(secondValue || "");

  if (first === second) {
    return 0;
  }

  if (!first.length) {
    return second.length;
  }

  if (!second.length) {
    return first.length;
  }

  const previous = [];
  const current = [];

  for (let column = 0; column <= first.length; column++) {
    previous[column] = column;
  }

  for (let row = 1; row <= second.length; row++) {
    current[0] = row;

    for (let column = 1; column <= first.length; column++) {
      const substitutionCost =
        second.charAt(row - 1) === first.charAt(column - 1) ? 0 : 1;

      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost
      );
    }

    for (let column = 0; column <= first.length; column++) {
      previous[column] = current[column];
    }
  }

  return previous[first.length];
}

/**
 * Ek token ka canonical roop.
 * Result cache hota hai, isliye 5000 books par bhi tez rehta hai.
 */
function canonicalToken_(rawToken) {
  const token = String(rawToken || "").trim();

  if (!token) {
    return "";
  }

  if (IBA_TOKEN_CACHE[token] !== undefined) {
    return IBA_TOKEN_CACHE[token];
  }

  const lookup = getConceptLookup_();
  let result = token;

  if (lookup.exact[token]) {
    result = lookup.exact[token];

  } else if (/^\d+$/.test(token) || token.length < 4 || token.length > 14) {
    result = token;

  } else if (/\d/.test(token)) {
    /*
     * Letters + digits = SKU / product code (jaise "nshcpe10").
     * Isko kisi subject se fuzzy-match karna galat hoga,
     * aur ye poore index build ka sabse mehnga hissa tha.
     */
    result = token;

  } else {
    /* Step 1: phonetic match — typo aur Hindi spelling ke liye. */
    const phonetic = token.length >= 5 ? phoneticKey_(token) : "";

    if (phonetic && lookup.phonetic[phonetic]) {
      result = lookup.phonetic[phonetic];

    } else {
      /* Step 2: same pehla letter wale keys me Levenshtein. */
      const candidates = lookup.buckets[token.charAt(0)] || [];

      const allowedDistance =
        token.length >= 9 ? 3 : token.length >= 6 ? 2 : 1;

      let nearestKey = "";
      let nearestDistance = Infinity;

      for (let index = 0; index < candidates.length; index++) {
        const key = candidates[index];

        if (Math.abs(token.length - key.length) > 3) {
          continue;
        }

        const distance = levenshteinDistance_(token, key);

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestKey = key;

          if (distance === 1) {
            break;
          }
        }
      }

      if (nearestKey && nearestDistance <= allowedDistance) {
        result = lookup.exact[nearestKey];
      }
    }
  }

  if (IBA_TOKEN_CACHE_COUNT < IBA_TOKEN_CACHE_LIMIT) {
    IBA_TOKEN_CACHE[token] = result;
    IBA_TOKEN_CACHE_COUNT++;
  }

  return result;
}

/**
 * Dictionary sheet ko n-gram lookup table me compile karta hai.
 * Ek execution me ek hi baar chalta hai.
 */
function getCompiledDictionary_(dictionary) {
  const map = dictionary || {};

  if (IBA_COMPILED_DICTIONARY && IBA_COMPILED_DICTIONARY.source === map) {
    return IBA_COMPILED_DICTIONARY.value;
  }

  const lookup = {};
  let maxWords = 1;

  Object.keys(map).forEach(function (alias) {
    const canonical = map[alias];

    if (!alias || !canonical) {
      return;
    }

    lookup[alias] = canonical;

    const wordCount = alias.split(" ").length;

    if (wordCount > maxWords) {
      maxWords = wordCount;
    }
  });

  const compiled = {
    lookup: lookup,
    maxWords: Math.min(maxWords, 6)
  };

  IBA_COMPILED_DICTIONARY = {
    source: map,
    value: compiled
  };

  return compiled;
}

/**
 * Dictionary sheet ke alias apply karta hai.
 * Longest phrase pehle match hota hai, isliye
 * "physical education" pehle milega, "art" baad me.
 */
function applyTrainingDictionary_(value, dictionary) {
  const text = basicNormalize_(value);

  if (!text) {
    return "";
  }

  const compiled = getCompiledDictionary_(dictionary);
  const words = text.split(" ");
  const output = [];

  let index = 0;

  while (index < words.length) {
    let matched = false;

    const maxSpan = Math.min(compiled.maxWords, words.length - index);

    for (let span = maxSpan; span >= 1; span--) {
      const phrase = words.slice(index, index + span).join(" ");
      const canonical = compiled.lookup[phrase];

      if (canonical) {
        output.push(canonical);
        index += span;
        matched = true;
        break;
      }
    }

    if (!matched) {
      output.push(words[index]);
      index++;
    }
  }

  return output.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Final searchable tokens.
 * Stop words do baar hatte hain — kyunki concept mapping ke baad
 * bhi naye stop words ban sakte hain (pustak -> book).
 */
function canonicalTokens_(value, dictionary) {
  const trainedText = applyTrainingDictionary_(value, dictionary);

  if (!trainedText) {
    return [];
  }

  return trainedText
    .split(" ")
    .filter(Boolean)
    .filter(function (token) {
      return !SEARCH_STOP_WORDS.has(token);
    })
    .map(canonicalToken_)
    .filter(Boolean)
    .filter(function (token) {
      return !SEARCH_STOP_WORDS.has(token);
    });
}

function canonicalText_(value, dictionary) {
  return canonicalTokens_(value, dictionary).join(" ");
}

/* ------------------------------------------------------------------ */
/* DICTIONARY SHEET                                                    */
/* ------------------------------------------------------------------ */

/**
 * Dictionary sheet banata hai. Agar sheet pehle se hai aur header
 * theek hai to chhoo kar bhi nahi jata — data safe rehta hai.
 */
function ensureDictionarySheet_() {
  const spreadsheet = getSpreadsheet_();

  let sheet = spreadsheet.getSheetByName(CONFIG.DICTIONARY_SHEET);

  if (sheet) {
    const firstHeader = String(
      sheet.getRange(1, 1).getValue() || ""
    ).trim();

    if (firstHeader === DICTIONARY_HEADERS[0]) {
      return sheet;
    }

    /*
     * Header galat hai. V3 yahan sheet.clear() karta tha aur
     * saara manual training data uda deta tha. Ab backup banta hai.
     */
    sheet.setName(
      getUniqueBackupSheetName_(spreadsheet, CONFIG.DICTIONARY_SHEET)
    );
  }

  sheet = spreadsheet.insertSheet(CONFIG.DICTIONARY_SHEET);

  sheet
    .getRange(1, 1, 1, DICTIONARY_HEADERS.length)
    .setValues([DICTIONARY_HEADERS])
    .setFontWeight("bold")
    .setBackground("#2C3A54")
    .setFontColor("#FFFFFF");

  const seedRows = getDictionarySeedRows_();

  sheet
    .getRange(2, 1, seedRows.length, DICTIONARY_HEADERS.length)
    .setValues(seedRows);

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 190);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidth(3, 520);
  sheet.setColumnWidth(4, 90);
  sheet.setColumnWidth(5, 260);

  return sheet;
}

/**
 * Starting training data. Hindi shabd Devanagari me bhi diye hain,
 * kyunki basicNormalize_ unko automatically transliterate kar deta hai.
 */
function getDictionarySeedRows_() {
  return [
    ["pe", "physical edu", "p e,p ed,phy edu,physical education,physcial education,phisical education,sharirik shiksha,शारीरिक शिक्षा", "Yes", "Physical Education group"],
    ["ai", "artificial intelligence", "a i,artificial intel,artifical intelligence", "Yes", "Artificial Intelligence group"],
    ["art", "art", "arts,kala,chitrakala,drawing,painting,fine arts,visual arts,craft,art education,कला,चित्रकला", "Yes", "Art / Kala group"],
    ["math", "math", "maths,mathematics,mathematic,ganit,ganita,गणित", "Yes", "Mathematics group"],
    ["sci", "sci", "science,sciences,vigyan,vignan,विज्ञान", "Yes", "Science group"],
    ["computer", "computer", "computers,computor,comp,sanganak,संगणक", "Yes", "Computer group"],
    ["computer app", "computer app", "computer application,computer applications,comp app", "Yes", "Computer Application group"],
    ["physics", "physics", "physic,phisics,phy,bhautiki,भौतिकी", "Yes", "Physics group"],
    ["chemistry", "chemistry", "chemestry,chem,rasayan,rasayan vigyan,रसायन", "Yes", "Chemistry group"],
    ["biology", "biology", "biolgy,bio,jeev vigyan,jiv vigyan,जीव विज्ञान", "Yes", "Biology group"],
    ["eco", "eco", "economics,economic,economy,arthshastra,arthashastra,अर्थशास्त्र", "Yes", "Economics group"],
    ["accounts", "accounts", "accountancy,accounting,account,lekhashastra,लेखाशास्त्र", "Yes", "Accountancy group"],
    ["geo", "geo", "geography,geograpy,bhugol,भूगोल", "Yes", "Geography group"],
    ["history", "history", "histry,itihas,itihaas,इतिहास", "Yes", "History group"],
    ["civics", "civics", "civic,nagrik shastra,nagrik,नागरिक शास्त्र", "Yes", "Civics group"],
    ["social", "social", "social science,social studies,samajik vigyan,samajik adhyayan,सामाजिक विज्ञान", "Yes", "Social Science group"],
    ["hindi", "hindi", "hindii,हिंदी,हिन्दी", "Yes", "Hindi subject"],
    ["english", "english", "englis,angreji,angrezi,अंग्रेजी", "Yes", "English subject"],
    ["sanskrit", "sanskrit", "sanskrat,संस्कृत", "Yes", "Sanskrit subject"],
    ["grammar", "grammar", "grammer,vyakaran,vyakran,byakaran,व्याकरण", "Yes", "Grammar group"],
    ["saraswati", "new saraswati", "nsh,saraswati,sarswati,saraswti,saraswathi,new saraswati,सरस्वती", "Yes", "New Saraswati publisher"],
    ["arihant", "arihant", "arhant,aryhant,अरिहंत", "Yes", "Arihant publisher"],
    ["bharti bhawan", "bharti bhawan", "bharati bhavan,bharti bhavan,bharati bhawan,भारती भवन", "Yes", "Bharti Bhawan publisher"],
    ["s chand", "schand", "s chand,s-chand,schand,एस चांद", "Yes", "S Chand publisher"],
    ["rd", "rd sharma", "r d,rd sharma,r d sharma", "Yes", "RD Sharma author"],
    ["hc", "hc verma", "h c,hc verma,h c verma", "Yes", "HC Verma author"],
    ["sumita", "sumita arora", "sumita arora", "Yes", "Sumita Arora author"],
    ["ncert", "ncert", "n c e r t,एनसीईआरटी", "Yes", "NCERT"],
    ["pradeep", "pradeep", "pradip,प्रदीप", "Yes", "Pradeep publisher"],
    ["oswal", "oswal", "oswall,ओसवाल", "Yes", "Oswal publisher"],
    ["apc", "apc", "a p c", "Yes", "APC publisher"],
    ["navneet", "navneet", "navnit,नवनीत", "Yes", "Navneet publisher"]
  ];
}

/**
 * Dictionary sheet ko flat map me badalta hai.
 * Ek execution me ek hi baar sheet padhi jaati hai.
 */
function getTrainingDictionary_() {
  if (IBA_DICTIONARY_CACHE) {
    return IBA_DICTIONARY_CACHE;
  }

  const dictionary = {};

  try {
    const spreadsheet = getSpreadsheet_();
    const sheet = spreadsheet.getSheetByName(CONFIG.DICTIONARY_SHEET);

    if (sheet && sheet.getLastRow() >= 2) {
      const rows = sheet
        .getRange(2, 1, sheet.getLastRow() - 1, DICTIONARY_HEADERS.length)
        .getDisplayValues();

      rows.forEach(function (row) {
        const alias = basicNormalize_(row[0]);
        const canonical = basicNormalize_(row[1]);
        const relatedTerms = splitRelatedTerms_(row[2]);

        const activeValue = String(row[3] || "").trim().toLowerCase();

        const inactive =
          activeValue === "no" ||
          activeValue === "false" ||
          activeValue === "inactive" ||
          activeValue === "pending" ||
          activeValue === "0";

        if (!canonical || inactive) {
          return;
        }

        if (alias) {
          dictionary[alias] = canonical;
        }

        dictionary[canonical] = canonical;

        relatedTerms.forEach(function (term) {
          const normalizedTerm = basicNormalize_(term);

          if (normalizedTerm) {
            dictionary[normalizedTerm] = canonical;
          }
        });
      });
    }

  } catch (error) {
    /*
     * Dictionary fail hone par bhi search chalni chahiye.
     * Static synonyms aur concept map phir bhi kaam karenge.
     */
    console.warn("Dictionary read failed:", error);
  }

  IBA_DICTIONARY_CACHE = dictionary;

  return dictionary;
}

function splitRelatedTerms_(value) {
  return String(value || "")
    .split(/[,;\|\n]+/)
    .map(function (term) {
      return term.trim();
    })
    .filter(Boolean);
}

function escapeRegex_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Feedback se aayi suggestion Dictionary me "No" par jaati hai.
 * Active = Yes karne ke baad hi live hoti hai.
 */
function addDictionaryTrainingSuggestion_(
  aliasValue,
  canonicalValue,
  relatedTerm,
  remarks
) {
  const alias = basicNormalize_(aliasValue);
  const canonical = basicNormalize_(canonicalValue);

  if (!alias || !canonical) {
    return {
      added: false,
      reason: "Alias ya canonical keyword missing hai."
    };
  }

  if (alias === canonical) {
    return {
      added: false,
      reason: "Alias aur canonical same hain, suggestion ki zaroorat nahi."
    };
  }

  const sheet = ensureDictionarySheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const existingAliases = sheet
      .getRange(2, 1, lastRow - 1, 1)
      .getDisplayValues()
      .map(function (row) {
        return basicNormalize_(row[0]);
      });

    if (existingAliases.indexOf(alias) !== -1) {
      return {
        added: false,
        reason: "Ye alias Dictionary me pehle se hai."
      };
    }
  }

  sheet.appendRow([
    alias,
    canonical,
    relatedTerm || "",
    "No",
    remarks || "Feedback suggestion — approval pending"
  ]);

  return {
    added: true,
    alias: alias,
    canonical: canonical
  };
}
