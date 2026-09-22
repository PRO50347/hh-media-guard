const aliases: Record<string, string> = {
  en: "eng",
  eng: "eng",
  english: "eng",
  es: "spa",
  spa: "spa",
  spanish: "spa",
  español: "spa",
  fr: "fra",
  fra: "fra",
  fre: "fra",
  french: "fra",
  français: "fra",
  de: "deu",
  deu: "deu",
  ger: "deu",
  german: "deu",
  deutsch: "deu",
  ja: "jpn",
  jpn: "jpn",
  japanese: "jpn",
  it: "ita",
  ita: "ita",
  italian: "ita",
  pt: "por",
  por: "por",
  portuguese: "por",
  zh: "zho",
  zho: "zho",
  chi: "zho",
  chinese: "zho",
  ru: "rus",
  rus: "rus",
  russian: "rus",
  ko: "kor",
  kor: "kor",
  korean: "kor",
  nl: "nld",
  nld: "nld",
  dut: "nld",
  dutch: "nld",
  ar: "ara",
  ara: "ara",
  arabic: "ara",
  hi: "hin",
  hin: "hin",
  hindi: "hin",
  sv: "swe",
  swe: "swe",
  swedish: "swe",
  no: "nor",
  nor: "nor",
  da: "dan",
  dan: "dan",
  fi: "fin",
  fin: "fin",
  pl: "pol",
  pol: "pol",
  cs: "ces",
  ces: "ces",
  cze: "ces",
  tr: "tur",
  tur: "tur",
  uk: "ukr",
  ukr: "ukr",
  he: "heb",
  heb: "heb",
  el: "ell",
  ell: "ell",
  gre: "ell",
};
export function normalizeLanguage(value?: string) {
  const key = (value || "").trim().toLowerCase();
  return aliases[key] || aliases[key.split(/[-_ (]/)[0]] || "und";
}
export function isCommentary(
  title?: string,
  disposition?: Record<string, number>,
) {
  return Boolean(
    disposition?.comment ||
    /commentary|director.?s? comments?|cast comments?|isolated (score|music)|bonus|extras/i.test(
      title || "",
    ),
  );
}
export function isDescriptive(
  title?: string,
  disposition?: Record<string, number>,
) {
  return Boolean(
    disposition?.visual_impaired ||
    /audio description|descriptive|described audio|\bAD\b/i.test(title || ""),
  );
}
