"""A lexicon entry's key, which the analysis gives each token and the lexicon each entry, so a
token finds its entry."""

from .ud import Upos

NO_LEMMA_ID: set[Upos] = {"PUNCT", "SYM"}


def lemma_id(lang: str, lemma: str | None, upos: Upos) -> str | None:
    """{lang}:{lemma}:{upos}, e.g. pl:pies:NOUN; None for punctuation and symbols."""
    if not lemma or upos in NO_LEMMA_ID:
        return None
    return f"{lang}:{lemma}:{upos}"
