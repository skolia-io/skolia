"""Analysis blob + lexicon -> the lexicon slice a document needs on the phone."""

from .. import ud
from ..schema import Blob, Upos
from . import entry
from .entry import CLOSEST_UPOS, Extras, FeatsTable, pronounce, record
from .schema import BUNDLE_SCHEMA, Bundle, Match, pronunciation_key
from .store import Lexicon, Row

LEMMA_ID_SEP = ":"


def parse_lemma_id(value: str) -> tuple[str, str, Upos]:
    """pl:pies:NOUN -> (pl, pies, NOUN). The lemma itself may contain the separator."""
    lang, rest = value.split(LEMMA_ID_SEP, 1)
    lemma, upos = rest.rsplit(LEMMA_ID_SEP, 1)
    if not ud.is_upos(upos):
        raise ud.UnknownLabel(f"lemma_id {value!r}: unknown UPOS {upos!r}")
    return lang, lemma, upos


def resolve(lexicon: Lexicon, lemma_id: str) -> tuple[Row | None, Match]:
    """The entry for a token's lemma_id, falling back to the lemma lowercased under the same
    part of speech, then to the same lemma under another part of speech, then to the lemma
    lowercased under any. A capitalised adjective in a name (Old Town) is the adjective,
    not the proper noun Old."""
    lang, lemma, upos = parse_lemma_id(lemma_id)
    row = lexicon.get(lemma_id)
    if row is not None:
        return row, "exact" if row.senses else "none"
    if lemma != lemma.lower():
        lowered = lexicon.get(f"{lang}{LEMMA_ID_SEP}{lemma.lower()}{LEMMA_ID_SEP}{upos}")
        if lowered is not None and lowered.senses:
            return lowered, "lowercase"
    same_lemma = [row for row in lexicon.by_lemma(lemma) if row.senses]
    if same_lemma:
        closest = CLOSEST_UPOS.get(upos, ())
        # sorted is stable: within a rank, by_lemma's most-senses order stays
        ranked = sorted(
            same_lemma, key=lambda r: closest.index(r.upos) if r.upos in closest else len(closest)
        )
        return ranked[0], "other-pos"
    if lemma != lemma.lower():
        any_pos = [row for row in lexicon.by_lowercase(lemma) if row.senses]
        if any_pos:
            return any_pos[0], "lowercase"
    return None, "none"


def make(blob: Blob, lexicon: Lexicon, extras: Extras | None = None) -> Bundle:
    bundle: Bundle = {
        "schema": BUNDLE_SCHEMA,
        "lang": blob["lang"],
        "lexicon": lexicon.version(),
        "attribution": lexicon.meta().get("attribution", ""),
        "entries": {},
        "lookup": {},
        "feats": [],
        "pronunciations": {},
        "recordings": {},
    }
    feats = FeatsTable(bundle["feats"])
    extras = extras or Extras()
    seen: set[str] = set()
    resolved: set[str] = set()
    for sentence in blob["sentences"]:
        for token in sentence["tokens"]:
            key = pronunciation_key(token["text"], token["upos"])
            if token["upos"] != "PUNCT" and key not in seen:
                seen.add(key)
                if found := pronounce(lexicon, token["text"], token["upos"]):
                    bundle["pronunciations"][key] = found
                if heard := record(lexicon, token["text"], token["upos"]):
                    bundle["recordings"][key] = heard
            token_id = token["lemma_id"]
            if token_id is None or token_id in resolved:
                continue
            resolved.add(token_id)
            row, _match = resolve(lexicon, token_id)
            if row is None:
                _lang, lemma, upos = parse_lemma_id(token_id)
                row = Row(token_id, lemma, upos, [], [], [], {})
            if row.lemma_id != token_id:
                bundle["lookup"][token_id] = row.lemma_id
            if row.lemma_id not in bundle["entries"]:
                bundle["entries"][row.lemma_id] = entry.make(lexicon, row, extras, feats)
    return bundle
