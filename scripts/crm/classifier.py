"""
scripts/crm/classifier.py
Multilingual Intent Classifier for ProductSafetyEngine CRM.

Klassifiziert eingehende E-Mails multilingual in:
- NEGATIVE_OPTOUT (Nein, Non, Nee, Kein Interesse, Pas intéressé, Geen interesse, Unsubscribe)
- POSITIVE_TEST_REQUEST (Produkte, EANs, Testanfrage, Oui, Ja, Gerne)
- GENERAL_INQUIRY (Fragen zu Preisen, APIs, GPSR, etc.)
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import List, Optional, Tuple


class Intent:
    NEGATIVE_OPTOUT = "NEGATIVE_OPTOUT"
    POSITIVE_TEST_REQUEST = "POSITIVE_TEST_REQUEST"
    GENERAL_INQUIRY = "GENERAL_INQUIRY"


VALID_INTENTS = {
    Intent.NEGATIVE_OPTOUT,
    Intent.POSITIVE_TEST_REQUEST,
    Intent.GENERAL_INQUIRY,
}


@dataclass
class ClassificationResult:
    intent: str
    confidence: float
    detected_language: str
    matched_patterns: List[str] = field(default_factory=list)
    eans_detected: List[str] = field(default_factory=list)
    clean_text: str = ""
    reason: str = ""


# ---------------------------------------------------------------------------
# Text Preprocessing & Quoted Reply Stripping
# ---------------------------------------------------------------------------

REPLY_HEADER_PATTERNS = [
    re.compile(r"^[-—]+\s*Original Message\s*[-—]+", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^[-—]+\s*Message d['’]origine\s*[-—]+", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^[-—]+\s*Oorspronkelijk bericht\s*[-—]+", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^[-—]+\s*Ursprüngliche Nachricht\s*[-—]+", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^(?:On|Le|Op|Am)\s+.+?\s+(?:wrote|a écrit|schreef|schrieb)\s*:?", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^(?:From|De|Van|Von)\s*:\s*.+", re.IGNORECASE | re.MULTILINE),
]


def strip_quoted_reply(body: str) -> str:
    """
    Entfernt zitierte urspruengliche E-Mails (z.B. '> ...' oder 'On ... wrote:'),
    damit Text aus der Outreach-Mail (z.B. '50 Artikel testen') nicht die Antwort
    des Empfaengers verfaelscht.
    """
    if not body:
        return ""

    # 1. Zuerst pruefen, ob ein Reply-Header existiert, und alles danach abschneiden
    cut_pos = len(body)
    for pattern in REPLY_HEADER_PATTERNS:
        match = pattern.search(body)
        if match and match.start() < cut_pos:
            cut_pos = match.start()

    clean = body[:cut_pos]

    # 2. Zeilenweises Filtern von Zitat-Praefixen ('>', '>>', etc.)
    filtered_lines: List[str] = []
    for line in clean.splitlines():
        stripped = line.strip()
        if stripped.startswith(">"):
            continue
        filtered_lines.append(line)

    result = "\n".join(filtered_lines).strip()
    # Sicherheits-Schranke: Falls nach Zitat-Bereinigung nichts uebrig bleibt,
    # niemals auf den unbereinigten Zitier-Text zurueckfallen (verhindert False-Positive Opt-Outs aus Zitaten).
    return result if result else ""


def normalize_text(text: str) -> str:
    """Wandelt Text in Kleinbuchstaben um und normalisiert Whitespace."""
    if not text:
        return ""
    # Unicode-Normalisierung NFKD (fuer robusteren Vergleich)
    return " ".join(text.lower().split())


def strip_accents(text: str) -> str:
    """Entfernt Akzente (z.B. é -> e, ï -> i, ü -> u) fuer Fehlertoleranz."""
    return "".join(
        c for c in unicodedata.normalize("NFD", text)
        if unicodedata.category(c) != "Mn"
    )


# ---------------------------------------------------------------------------
# EAN / GTIN Extraction
# ---------------------------------------------------------------------------

EAN_REGEX = re.compile(r"\b(\d{8}|\d{12,14})\b")


def validate_gtin_checksum(digits: str) -> bool:
    """Prueft die offizielle GS1/GTIN Modulo-10 Pruefziffer."""
    if not digits.isdigit() or len(digits) not in (8, 12, 13, 14):
        return False
    body = digits[:-1]
    check_digit = int(digits[-1])
    
    # Reverse multiplier: alternating 3 and 1 from right to left
    total = 0
    multiplier = 3
    for d in reversed(body):
        total += int(d) * multiplier
        multiplier = 1 if multiplier == 3 else 3
        
    calc_check = (10 - (total % 10)) % 10
    return calc_check == check_digit


def extract_eans(text: str, validate_checksum: bool = False) -> List[str]:
    """
    Extrahiert Barcodes / EANs (GTIN-8, 12, 13, 14) aus Text.
    Falls validate_checksum=True, werden nur mathematisch valide GTINs zurueckgegeben.
    """
    if not text:
        return []

    found = EAN_REGEX.findall(text)
    unique_eans: List[str] = []
    seen = set()

    for item in found:
        if item in seen:
            continue
        # Telefonnummern oder Jahreszahlen ausschliessen, wenn keine Validierung gewuenscht
        # z.B. 20261119 ist 8 Ziffern, aber ein Datum.
        if validate_checksum:
            if validate_gtin_checksum(item):
                unique_eans.append(item)
                seen.add(item)
        else:
            # Pragmatischer Filter: Nicht rein aus identischen Ziffern (00000000)
            if len(set(item)) > 1:
                unique_eans.append(item)
                seen.add(item)

    return unique_eans


# ---------------------------------------------------------------------------
# Pattern Definitions (FR, NL, DE, EN)
# ---------------------------------------------------------------------------

# 1. NEGATIVE_OPTOUT
PATTERNS_NEGATIVE = {
    # Franzoesisch
    "fr": [
        r"\bnon\b",
        r"\bnon\s+merci\b",
        r"\bpas\s+int[ée]ress[ée]\b",
        r"\bpas\s+d['’]int[ée]r[eê]t\b",
        r"\baucun\s+int[ée]r[eê]t\b",
        r"\bne\s+plus\s+(?:me\s+|nous\s+)?contacter\b",
        r"\bne\s+plus\s+(?:me\s+|nous\s+)?contactez\b",
        r"\bne\s+m['’][ée]crivez\s+plus\b",
        r"\bretirez[- ](?:moi|nous)\b",
        r"\bretirer\b",
        r"\bsupprimer\b",
        r"\bsupprimez\b",
        r"\bd[ée]sabonner\b",
        r"\bd[ée]sinscription\b",
        r"\bne\s+souhaitons\s+pas\b",
        r"\bne\s+suis\s+pas\s+int[ée]ress[ée]\b",
        r"\bmerci\s+de\s+ne\s+plus\b",
        r"\brefus\b",
    ],
    # Niederlaendisch
    "nl": [
        r"\bnee\b",
        r"\bnee\s+bedankt\b",
        r"\bnee\s+dank\s*u\b",
        r"\bgeen\s+interesse\b",
        r"\bgeen\s+belangstelling\b",
        r"\bgeen\s+behoefte\b",
        r"\bniet\s+ge[ïi]nteresseerd\b",
        r"\buit\s*(?:te\s*)?schrijven\b",
        r"\baf\s*(?:te\s*)?melden\b",
        r"\bschrap\s+ons\b",
        r"\bniet\s+meer\s+(?:te\s+)?contacteren\b",
        r"\bstop\s+met\s+mailen\b",
        r"\bverwijder(?:en)?\b",
    ],
    # Deutsch
    "de": [
        r"\bnein\b",
        r"\bnein\s+danke\b",
        r"\bkein\s+interesse\b",
        r"\bkeinen\s+bedarf\b",
        r"\bnicht\s+interessiert\b",
        r"\babmelden\b",
        r"\baustragen\b",
        r"\bbitte\s+l[öo]schen\b",
        r"\bkeine\s+e[- ]?mails\s+mehr\b",
        r"\bkontakt\s+unterlassen\b",
        r"\babmeldung\b",
        r"\bwiderruf\b",
        r"\bkeine\s+werbung\b",
        r"\bunerw[üu]nscht\b",
        r"\bbitte\s+entfernen\b",
        r"\bspam\b",
    ],
    # Englisch
    "en": [
        r"\bno\b(?!\s+(?:problem|worries))",
        r"\bno\s*,?\s*thanks\b",
        r"\bno\s*,?\s*thank\s+you\b",
        r"\bnot\s+interested\b",
        r"\bno\s+interest\b",
        r"\bnot\s+for\s+us\b",
        r"\bunsubscribe\b",
        r"\bopt[- ]out\b",
        r"\bremove\s+me\b",
        r"\bplease\s+remove\b",
        r"\bstop\s+sending\b",
        r"\bdo\s+not\s+contact\b",
        r"\bdon['’]t\s+contact\b",
        r"\btake\s+me\s+off\s+your\s+list\b",
        r"\bleave\s+us\s+alone\b",
    ],
}

# 2. POSITIVE_TEST_REQUEST
PATTERNS_POSITIVE = {
    # Franzoesisch
    "fr": [
        r"\boui\b",
        r"\bvolontiers\b",
        r"\bavec\s+plaisir\b",
        r"\bint[ée]ress[ée]\b",
        r"\bfaire\s+v[ée]rifier\b",
        r"\bv[ée]rifier\s+nos\b",
        r"\bv[ée]rification\b",
        r"\btester\b",
        r"\btest\s+gratuit\b",
        r"\b50\s+articles\b",
        r"\bvoici\s+nos\s+produits\b",
        r"\bvoici\s+nos\s+articles\b",
        r"\bvoici\s+les\s+ean\b",
        r"\bvoici\s+les\s+codes\b",
        r"\bnotre\s+catalogue\b",
        r"\bpouvez[- ]vous\s+tester\b",
        r"\bon\s+veut\s+bien\b",
        r"\bd['’]accord\b",
    ],
    # Niederlaendisch
    "nl": [
        r"\bja\b",
        r"\bgraag\b",
        r"\bja\s+graag\b",
        r"\bmet\s+plezier\b",
        r"\bge[ïi]nteresseerd\b",
        r"\bwe\s+willen\s+graag\b",
        r"\blaten\s+controleren\b",
        r"\bcontroleren\b",
        r"\btesten\b",
        r"\bgratis\s+test\b",
        r"\b50\s+artikelen\b",
        r"\bhierbij\s+onze\b",
        r"\bhier\s+zijn\s+de\s+eans\b",
        r"\bonze\s+producten\b",
        r"\bonze\s+artikelen\b",
        r"\btestaanvraag\b",
        r"\bakkoord\b",
        r"\bprima\b",
    ],
    # Deutsch
    "de": [
        r"\bja\b",
        r"\bgerne\b",
        r"\bja\s+gerne\b",
        r"\bmit\s+freude\b",
        r"\bsehr\s+gerne\b",
        r"\binteressiert\b",
        r"\bwir\s+m[öo]chten\s+testen\b",
        r"\btesten\b",
        r"\b[üu]berpr[üu]fen\b",
        r"\bpr[üu]fen\b",
        r"\btestanfrage\b",
        r"\bkostenloser\s+test\b",
        r"\b50\s+artikel\b",
        r"\bunsere\s+produkte\b",
        r"\bunsere\s+artikel\b",
        r"\bhier\s+sind\s+unsere\b",
        r"\bhier\s+die\s+eans\b",
        r"\bangebot\s+annehmen\b",
        r"\bprobe\b",
        r"\beinverstanden\b",
    ],
    # Englisch
    "en": [
        r"\byes\b",
        r"\bsure\b",
        r"\byes\s+please\b",
        r"\bwith\s+pleasure\b",
        r"\binterested\b",
        r"\bwould\s+like\s+to\s+test\b",
        r"\btest\s+our\s+products\b",
        r"\bfree\s+test\b",
        r"\b50\s+products\b",
        r"\b50\s+items\b",
        r"\bhere\s+are\s+our\s+eans\b",
        r"\bhere\s+are\s+our\s+products\b",
        r"\bcheck\s+our\s+products\b",
        r"\bproduct\s+list\b",
        r"\bsounds\s+good\b",
        r"\bagreed\b",
        r"\blet['’]s\s+test\b",
    ],
}

# 3. GENERAL_INQUIRY
PATTERNS_INQUIRY = {
    "fr": [
        r"\bquestion\b",
        r"\bprix\b",
        r"\btarif\b",
        r"\bcombien\b",
        r"\bco[ûu]t\b",
        r"\bcomment\s+[çc]a\s+marche\b",
        r"\bapi\b",
        r"\bapify\b",
        r"\bgpsr\b",
        r"\bcompliance\b",
        r"\brenseignement\b",
        r"\bpr[ée]cision\b",
    ],
    "nl": [
        r"\bvraag\b",
        r"\bkosten\b",
        r"\bprijs\b",
        r"\btarief\b",
        r"\bhoeveel\b",
        r"\bhoe\s+werkt\b",
        r"\bapi\b",
        r"\bapify\b",
        r"\bgpsr\b",
        r"\binformatie\b",
        r"\bmeer\s+info\b",
    ],
    "de": [
        r"\bfrage\b",
        r"\bpreis\b",
        r"\bkosten\b",
        r"\bwas\s+kostet\b",
        r"\bwie\s+funktioniert\b",
        r"\bschnittstelle\b",
        r"\bapi\b",
        r"\bapify\b",
        r"\bgpsr\b",
        r"\binformationen\b",
        r"\br[üu]ckfrage\b",
    ],
    "en": [
        r"\bquestion\b",
        r"\bprice\b",
        r"\bpricing\b",
        r"\bcost\b",
        r"\bhow\s+much\b",
        r"\bhow\s+does\s+it\s+work\b",
        r"\bapi\b",
        r"\bapify\b",
        r"\bgpsr\b",
        r"\binformation\b",
        r"\binquiry\b",
        r"\bdetails\b",
    ],
}


def detect_language(text: str) -> str:
    """
    Einfache heuristische Spracherkennung anhand typischer Signalwoerter
    fuer FR, NL, DE und EN.
    """
    norm = normalize_text(text)
    scores = {"fr": 0, "nl": 0, "de": 0, "en": 0}

    # Signalwoerter
    signals = {
        "fr": ["bonjour", "merci", "nous", "vous", "pas", "avec", "pour", "dans", "votre", "notre", "cordialement"],
        "nl": ["hallo", "bedankt", "wij", "jullie", "geen", "met", "voor", "onze", "graag", "vriendelijke", "groet"],
        "de": ["hallo", "guten", "tag", "danke", "wir", "nicht", "kein", "mit", "fuer", "unsere", "gruesse"],
        "en": ["hello", "thank", "thanks", "we", "not", "with", "for", "our", "regards", "please"],
    }

    words = set(re.findall(r"\b[a-zA-Zàâäéèêëïîôöùûüç]+\b", norm))
    for lang, lang_words in signals.items():
        for lw in lang_words:
            if lw in words:
                scores[lang] += 1

    best_lang = max(scores, key=scores.get)
    return best_lang if scores[best_lang] > 0 else "en"


# ---------------------------------------------------------------------------
# Core Classification Function
# ---------------------------------------------------------------------------

def classify_intent(body: str, subject: str = "") -> ClassificationResult:
    """
    Klassifiziert den Intent einer eingehenden E-Mail:
    1. NEGATIVE_OPTOUT (hoechste Prioritaet: Opt-Out schlaegt alles)
    2. POSITIVE_TEST_REQUEST (Test-Wunsch, 'Oui/Ja/Gerne' oder EAN-Nennung)
    3. GENERAL_INQUIRY (Fragen oder Rueckfragen)
    
    Arbeitet multilingual fuer Franzoesisch (FR), Niederlaendisch (NL),
    Deutsch (DE) und Englisch (EN).
    """
    # 1. Zitate entfernen, um Quelltext der Outreach-Mail auszublenden
    clean_body = strip_quoted_reply(body)
    full_text = f"{subject}\n{clean_body}".strip()
    norm_text = normalize_text(full_text)
    norm_body = normalize_text(clean_body)

    lang = detect_language(full_text)
    eans = extract_eans(clean_body, validate_checksum=False)

    # -----------------------------------------------------------------------
    # SCHRITT 1: NEGATIVE_OPTOUT PRUEFEN (Absolute Prioritaet!)
    # -----------------------------------------------------------------------
    negative_matches: List[str] = []

    # Filter fuer False Positives bei Redewendungen (z.B. 'No problem', 'Pas de problème', 'Kein Problem')
    has_no_problem = bool(re.search(r"\b(?:no\s+problem|pas\s+de\s+probl[èe]me|kein\s+problem|geen\s+probleem)\b", norm_body, re.IGNORECASE))

    # Wir pruefen sowohl den bereinigten Body als auch Fulltext
    for lang_code, patterns in PATTERNS_NEGATIVE.items():
        for pat in patterns:
            # Suche im bereinigten Body (und Betreff)
            match = re.search(pat, norm_body, re.IGNORECASE)
            if not match:
                # Auch im Betreff suchen
                match = re.search(pat, normalize_text(subject), re.IGNORECASE)
            
            if match:
                matched_str = match.group(0).lower()
                # Falls z.B. 'kein' oder 'pas' oder 'geen' nur innerhalb von 'kein Problem' / 'pas de problème' vorkommt
                if has_no_problem and matched_str in ("pas", "kein", "geen", "no"):
                    continue
                negative_matches.append(match.group(0))

    if negative_matches:
        # Absage erkannt!
        reason = f"Negative Opt-Out detected ({len(negative_matches)} pattern matches: {', '.join(negative_matches[:3])})"
        return ClassificationResult(
            intent=Intent.NEGATIVE_OPTOUT,
            confidence=0.98 if len(negative_matches) > 1 else 0.95,
            detected_language=lang,
            matched_patterns=negative_matches,
            eans_detected=eans,
            clean_text=clean_body,
            reason=reason,
        )

    # -----------------------------------------------------------------------
    # SCHRITT 2: POSITIVE_TEST_REQUEST PRUEFEN
    # -----------------------------------------------------------------------
    positive_matches: List[str] = []

    # Explizite EANs genannt -> Starkes Signal fuer Testanfrage
    if eans:
        positive_matches.append(f"EANs({len(eans)})")

    # Pruefe auch Erwaehnung von 'EAN', 'GTIN', 'Barcode', 'Code-barres' etc.
    if re.search(r"\b(?:ean|gtin|barcodes?|code-barres?|streepjescodes?)\b", norm_body, re.IGNORECASE):
        positive_matches.append("keyword:ean/barcode")

    for lang_code, patterns in PATTERNS_POSITIVE.items():
        for pat in patterns:
            match = re.search(pat, norm_body, re.IGNORECASE)
            if match:
                positive_matches.append(match.group(0))

    if positive_matches:
        # Testanfrage erkannt!
        confidence = 0.95 if eans or len(positive_matches) >= 2 else 0.85
        reason = f"Positive test request detected ({len(positive_matches)} signals: {', '.join(positive_matches[:3])})"
        return ClassificationResult(
            intent=Intent.POSITIVE_TEST_REQUEST,
            confidence=confidence,
            detected_language=lang,
            matched_patterns=positive_matches,
            eans_detected=eans,
            clean_text=clean_body,
            reason=reason,
        )

    # -----------------------------------------------------------------------
    # SCHRITT 3: GENERAL_INQUIRY (Default fuer neutrale Rueckfragen)
    # -----------------------------------------------------------------------
    inquiry_matches: List[str] = []
    for lang_code, patterns in PATTERNS_INQUIRY.items():
        for pat in patterns:
            match = re.search(pat, norm_body, re.IGNORECASE)
            if match:
                inquiry_matches.append(match.group(0))

    if "?" in clean_body:
        inquiry_matches.append("question_mark")

    reason = (
        f"General inquiry detected ({', '.join(inquiry_matches[:3])})"
        if inquiry_matches
        else "General inquiry (default fallback for inbound response)"
    )

    return ClassificationResult(
        intent=Intent.GENERAL_INQUIRY,
        confidence=0.75 if inquiry_matches else 0.60,
        detected_language=lang,
        matched_patterns=inquiry_matches,
        eans_detected=eans,
        clean_text=clean_body,
        reason=reason,
    )
