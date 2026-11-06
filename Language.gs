/**
 * IBA Smart Book Search — V4
 * File: Language.gs
 *
 * Kaam:
 * 1. Devanagari (Hindi) text ko Latin me transliterate karna.
 * 2. Phonetic key banana — spelling ke farq ko ignore karne ke liye.
 *    kitab / kitaab, vyakaran / vyakran, sarswati / saraswati — sab same key.
 * 3. Hindi <-> English concept mapping (vigyan = science = sci).
 *
 * Is file me koi sheet read/write nahi hota, sirf pure text functions hain.
 * Isliye ye sabse pehle load hota hai aur kabhi fail nahi karta.
 *
 * NOTE: Devanagari conjuncts aur special characters yahan \u escapes me
 * likhe hain taaki copy-paste me invisible characters kho na jayein.
 */

/* ------------------------------------------------------------------ */
/* 1. DEVANAGARI -> LATIN                                              */
/* ------------------------------------------------------------------ */

/*
 * Ye conjunct (do-teen letter jud kar bana akshar) pehle single
 * private-use character me badle jaate hain, warna galat sound aata hai.
 * Example: ज्ञ ko alag-alag padho to "jn" milega, lekin bolte "gy" hain.
 */
const IBA_DEV_CONJUNCTS = [
  ["क्ष", ""], /* क्ष -> ksh */
  ["ज्ञ", ""], /* ज्ञ -> gy  */
  ["त्र", ""], /* त्र -> tr  */
  ["श्र", ""], /* श्र -> shr */
  ["द्व", ""], /* द्व -> dv  */
  ["द्य", ""]  /* द्य -> dy  */
];

const IBA_DEV_CONSONANTS = {
  "": "ksh",
  "": "gy",
  "": "tr",
  "": "shr",
  "": "dv",
  "": "dy",

  "क": "k",  "ख": "kh", "ग": "g",  "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh","ज": "j",  "झ": "jh", "ञ": "n",
  "ट": "t",  "ठ": "th", "ड": "d",  "ढ": "dh", "ण": "n",
  "त": "t",  "थ": "th", "द": "d",  "ध": "dh", "न": "n",
  "प": "p",  "फ": "ph", "ब": "b",  "भ": "bh", "म": "m",
  "य": "y",  "र": "r",  "ल": "l",  "व": "v",  "ळ": "l",
  "श": "sh", "ष": "sh", "स": "s",  "ह": "h",

  /* Nukta wale pre-composed letters (U+0958 - U+095F). */
  "क़": "k", "ख़": "kh", "ग़": "g", "ज़": "z",
  "ड़": "r", "ढ़": "rh", "फ़": "f", "य़": "y"
};

const IBA_DEV_MATRAS = {
  "ा": "a",  "ि": "i",  "ी": "i",  "ु": "u",  "ू": "u",
  "ृ": "ri", "ॄ": "ri", "े": "e",  "ै": "ai", "ो": "o",
  "ौ": "au", "ॉ": "o",  "ॅ": "e",  "ॆ": "e",  "ॊ": "o"
};

const IBA_DEV_VOWELS = {
  "अ": "a",  "आ": "a",  "इ": "i",  "ई": "i",
  "उ": "u",  "ऊ": "u",  "ऋ": "ri",
  "ए": "e",  "ऐ": "ai", "ओ": "o",  "औ": "au",
  "ऍ": "e",  "ऑ": "o",  "ऎ": "e",  "ऒ": "o"
};

const IBA_DEV_SIGNS = {
  "ं": "n",  /* ं anusvara */
  "ँ": "n",  /* ँ chandrabindu */
  "ः": "h",  /* ः visarga */
  "़": "",   /* ़ nukta */
  "ऽ": "",   /* ऽ avagraha */
  "‍": "",   /* zero width joiner */
  "‌": ""    /* zero width non-joiner */
};

const IBA_DEV_HALANT = "्";

const IBA_DEV_DIGITS = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9"
};

/**
 * True agar text me koi Devanagari character hai.
 */
function hasDevanagari_(value) {
  return /[ऀ-ॿ]/.test(String(value || ""));
}

/**
 * Ek Devanagari word ko Latin me badalta hai.
 * Hindi me word ke end ka "a" bolne me gir jata hai
 * (पुस्तक = "pustak", "pustaka" nahi) — wo bhi handle hota hai.
 */
function transliterateDevanagariWord_(word) {
  let text = String(word || "");

  if (!text) {
    return "";
  }

  IBA_DEV_CONJUNCTS.forEach(function (pair) {
    text = text.split(pair[0]).join(pair[1]);
  });

  let output = "";
  let index = 0;

  /*
   * Ye flag batata hai ki last "a" matra se aaya (likha hua) ya
   * inherent tha (bina likhe). Sirf inherent "a" girta hai.
   * शिक्षा = "shiksha"  (matra se aaya, nahi girega)
   * पुस्तक = "pustak"   (inherent tha, gir gaya)
   */
  let lastVowelWasExplicit = false;

  while (index < text.length) {
    const character = text.charAt(index);

    if (IBA_DEV_DIGITS[character] !== undefined) {
      output += IBA_DEV_DIGITS[character];
      lastVowelWasExplicit = true;
      index++;
      continue;
    }

    if (IBA_DEV_CONSONANTS[character] !== undefined) {
      output += IBA_DEV_CONSONANTS[character];
      index++;

      /* Nukta sign ko skip karo. */
      while (index < text.length && text.charAt(index) === "़") {
        index++;
      }

      const next = index < text.length ? text.charAt(index) : "";

      if (next === IBA_DEV_HALANT) {
        /* Halant = inherent "a" nahi lagega. */
        lastVowelWasExplicit = true;
        index++;

      } else if (IBA_DEV_MATRAS[next] !== undefined) {
        output += IBA_DEV_MATRAS[next];
        lastVowelWasExplicit = true;
        index++;

      } else {
        /* Inherent "a". */
        output += "a";
        lastVowelWasExplicit = false;
      }

      continue;
    }

    if (IBA_DEV_VOWELS[character] !== undefined) {
      output += IBA_DEV_VOWELS[character];
      lastVowelWasExplicit = true;
      index++;
      continue;
    }

    if (IBA_DEV_MATRAS[character] !== undefined) {
      output += IBA_DEV_MATRAS[character];
      lastVowelWasExplicit = true;
      index++;
      continue;
    }

    if (IBA_DEV_SIGNS[character] !== undefined) {
      output += IBA_DEV_SIGNS[character];
      lastVowelWasExplicit = true;
      index++;
      continue;
    }

    /* Devanagari ke bahar ka character jaisa hai waisa rakho. */
    output += character;
    lastVowelWasExplicit = true;
    index++;
  }

  /* Word-final schwa deletion. */
  if (
    !lastVowelWasExplicit &&
    output.length > 3 &&
    output.charAt(output.length - 1) === "a"
  ) {
    output = output.substring(0, output.length - 1);
  }

  return output;
}

/**
 * Poore text ka transliteration, word by word.
 */
function transliterateDevanagari_(value) {
  const text = String(value || "");

  if (!hasDevanagari_(text)) {
    return text;
  }

  return text
    .split(/(\s+)/)
    .map(function (part) {
      return /\s/.test(part)
        ? part
        : transliterateDevanagariWord_(part);
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* 2. PHONETIC KEY                                                     */
/* ------------------------------------------------------------------ */

var IBA_PHONETIC_CACHE = {};
var IBA_PHONETIC_CACHE_COUNT = 0;
const IBA_PHONETIC_CACHE_LIMIT = 40000;

/*
 * Ye replacements order me chalte hain, isliye list ka order
 * badalna nahi hai. Do-letter sounds pehle, single letter baad me.
 */
const IBA_PHONETIC_RULES = [
  [/ph/g, "f"],
  [/chh/g, "c"],
  [/ch/g, "c"],
  [/sh/g, "s"],
  [/kh/g, "k"],
  [/gh/g, "g"],
  [/th/g, "t"],
  [/dh/g, "d"],
  [/bh/g, "b"],
  [/jh/g, "j"],
  [/gy/g, "g"],
  [/jn/g, "g"],
  [/ck/g, "k"],
  [/w/g, "v"],
  [/q/g, "k"],
  [/x/g, "ks"],
  [/z/g, "j"],
  [/aa/g, "a"],
  [/ee/g, "i"],
  [/ii/g, "i"],
  [/oo/g, "u"],
  [/uu/g, "u"],
  [/ai/g, "e"],
  [/ay/g, "e"],
  [/au/g, "o"],
  [/aw/g, "o"]
];

/**
 * Consonant skeleton banata hai.
 * "physical", "phisical", "pisical", "physicl" — sabka ek hi key.
 *
 * Ye jaan bujh kar aggressive hai, isliye search me iska score
 * exact match se kam rakha gaya hai aur sirf 4+ letter tokens
 * par use hota hai (SearchEngine.gs dekho).
 */
function phoneticKey_(token) {
  const raw = String(token || "").toLowerCase().trim();

  if (!raw) {
    return "";
  }

  if (IBA_PHONETIC_CACHE[raw] !== undefined) {
    return IBA_PHONETIC_CACHE[raw];
  }

  let text = raw.replace(/[^a-z0-9]/g, "");

  if (!text) {
    return "";
  }

  /* Number bilkul as-is rahega. */
  if (/^\d+$/.test(text)) {
    if (IBA_PHONETIC_CACHE_COUNT < IBA_PHONETIC_CACHE_LIMIT) {
      IBA_PHONETIC_CACHE[raw] = text;
      IBA_PHONETIC_CACHE_COUNT++;
    }
    return text;
  }

  IBA_PHONETIC_RULES.forEach(function (rule) {
    text = text.replace(rule[0], rule[1]);
  });

  /*
   * Pehla character rakho, baaki me se saare vowel aur "y" hatao.
   * Hindi me beech ka "a" bolne me girta hai
   * (vyakaran = vyakran), isliye ye zaroori hai.
   */
  const first = text.charAt(0);

  const rest = text
    .substring(1)
    .replace(/[aeiouy]/g, "");

  let key = (first + rest).replace(/(.)\1+/g, "$1");

  if (!key) {
    key = text.charAt(0);
  }

  if (IBA_PHONETIC_CACHE_COUNT < IBA_PHONETIC_CACHE_LIMIT) {
    IBA_PHONETIC_CACHE[raw] = key;
    IBA_PHONETIC_CACHE_COUNT++;
  }

  return key;
}

/**
 * Token list ka phonetic list.
 */
function phoneticKeys_(tokens) {
  return (Array.isArray(tokens) ? tokens : []).map(phoneticKey_);
}

/* ------------------------------------------------------------------ */
/* 3. HINDI <-> ENGLISH CONCEPT MAP                                    */
/* ------------------------------------------------------------------ */

/*
 * Left side: Hindi shabd (romanized) ya English variant.
 * Right side: canonical keyword jo inventory me use hota hai.
 *
 * Isse "vigyan 10", "विज्ञान 10" aur "science 10" — teeno
 * ek hi cheez ban jaate hain: "sci 10".
 *
 * Naye shabd yahan add kar sakte ho, ya Dictionary sheet me
 * (sheet me add karna better hai — script edit nahi karna padta).
 */
const IBA_HINDI_ENGLISH_CONCEPTS = {
  /* Subjects */
  "vigyan": "sci",
  "vigian": "sci",
  "vignan": "sci",
  "science": "sci",
  "sciences": "sci",

  "ganit": "math",
  "ganita": "math",
  "gnit": "math",
  "mathematics": "math",
  "mathematic": "math",
  "maths": "math",

  "vyakaran": "grammar",
  "vyakran": "grammar",
  "byakaran": "grammar",
  "grammer": "grammar",

  "itihas": "history",
  "itihaas": "history",
  "histry": "history",

  "bhugol": "geo",
  "bhoogol": "geo",
  "geography": "geo",
  "geograpy": "geo",
  "geographi": "geo",

  "nagrik": "civics",
  "nagarik": "civics",
  "nagrikshastra": "civics",
  "civic": "civics",

  "arthshastra": "eco",
  "arthashastra": "eco",
  "arthik": "eco",
  "economics": "eco",
  "economic": "eco",
  "economy": "eco",

  "lekhashastra": "accounts",
  "lekhankan": "accounts",
  "accountancy": "accounts",
  "accounting": "accounts",
  "account": "accounts",

  "rasayan": "chemistry",
  "rasayanshastra": "chemistry",
  "chemestry": "chemistry",
  "chem": "chemistry",

  "bhautiki": "physics",
  "bhoutiki": "physics",
  "physic": "physics",
  "phisics": "physics",

  "jeevvigyan": "biology",
  "jeev": "biology",
  "jiv": "biology",
  "jeevan": "biology",
  "biolgy": "biology",
  "bio": "biology",

  "samajik": "social",
  "samaj": "social",
  "samajshastra": "social",

  "angreji": "english",
  "angrezi": "english",
  "englis": "english",

  "sanskrit": "sanskrit",
  "sanskrat": "sanskrit",

  "kala": "art",
  "chitrakala": "art",
  "arts": "art",
  "drawing": "art",
  "painting": "art",

  "sharirik": "physical",
  "shaaririk": "physical",
  "physical": "physical",
  "phisical": "physical",
  "pisical": "physical",
  "physcial": "physical",
  "phyiscal": "physical",
  "physicl": "physical",

  "shiksha": "edu",
  "siksha": "edu",
  "education": "edu",
  "educational": "edu",
  "eduction": "edu",
  "educaton": "edu",

  "computer": "computer",
  "computor": "computer",
  "computers": "computer",
  "sanganak": "computer",

  "application": "app",
  "applications": "app",

  /* Book / structure words */
  "pustak": "book",
  "pustika": "book",
  "kitab": "book",
  "kitaab": "book",

  "abhyas": "practice",
  "abhyaas": "practice",
  "practise": "practice",

  "prashn": "question",
  "prashna": "question",
  "prashnottar": "question",

  "uttar": "answer",
  "sampurna": "complete",
  "sampoorn": "complete",
  "saral": "simple",
  "sugam": "easy",
  "adhyayan": "study",
  "bhag": "part",
  "khand": "part",
  "kaksha": "class",
  "shreni": "class",
  "srenii": "class",

  /* Publishers / authors — Hindi + English spellings */
  "sarswati": "saraswati",
  "saraswti": "saraswati",
  "saraswathi": "saraswati",
  "sarasvati": "saraswati",
  "arhant": "arihant",
  "aryhant": "arihant",
  "arihanth": "arihant",
  "bharati": "bharti",
  "bhaarti": "bharti",
  "bhavan": "bhawan",
  "bhawn": "bhawan",
  "agarwal": "aggarwal",
  "aggrawal": "aggarwal",
  "agrawal": "aggarwal",
  "sharma": "sharma",
  "verma": "verma",
  "navneet": "navneet",
  "navnit": "navneet",
  "oswall": "oswal",
  "pradip": "pradeep",
  "darpan": "darpan",

  /* Misc */
  "volume": "vol",
  "pt": "part",
  "adhyay": "chapter",
  "chapters": "chapter"
};

/**
 * Ek token ka concept mapping. Nahi mila to khali string.
 */
function conceptForToken_(token) {
  const key = String(token || "").toLowerCase().trim();

  if (!key) {
    return "";
  }

  return IBA_HINDI_ENGLISH_CONCEPTS[key] || "";
}
