"""Shape of the analysis blob JSON. Its labels are Universal Dependencies' (UD), in
skolia/ud.py.
"""

from typing import Literal, NotRequired, TypedDict

from skolia.ud import Case, Deprel, Feats, Reading, Upos

type CaseRule = Literal[
    "vocative",  # addressing someone: Kasiu!
    "preposition",  # the preposition decides: do psa (gen), z psem (ins)
    "agreement",  # takes the case of the noun it describes: starego psa
    "numeral",  # numbers from five, and quantity words, take the genitive: pięć psów
    "verb",  # the verb asks for this case: szukać psa (gen), pomagać bratu (dat)
    "negation",  # a negated verb's object is genitive: nie mam czasu
    "structural",  # a verb's ordinary object is accusative: mam czas
    "partitive",  # genitive for "some of", accusative for "all of": nalać wody / wodę
    "subject",  # the subject is nominative
    "predicate",  # after być, a noun is instrumental: jest lekarzem
    "description",  # after być, a genitive says what something is like: jakiego koloru są
    "possessive",  # "of": dom brata
    "noun-complement",  # a noun's complement is genitive: osiągnięcie kompromisu
    "verbal-noun",  # a verbal noun's object is genitive: czytać książkę -> czytanie książki
    "coordination",  # same case as the first item of a list: ryż, pszenica i żyto
    "instrumental",  # by means of, or when: pisać długopisem, wieczorem
]


class CaseReason(TypedDict):
    rule: CaseRule
    trigger: NotRequired[int]
    """Index in the sentence of the word that causes the case: the preposition, the verb,
    nie, the numeral, or the noun an adjective agrees with."""
    governor: NotRequired[str]
    """Lemma of the verb or preposition, for the explanation: szukać, do."""


class CaseCorrection(TypedDict):
    """The case was changed from the parser's because the governing verb requires another
    and the form is the same in both: psa after szukać is genitive, not accusative."""

    original: Case
    """The parser's case."""
    governor: str
    """Lemma of the verb that requires the case."""


class Token(TypedDict):
    start: int
    """Offset into the source text in UTF-16 code units, a JavaScript string index. Parts of a
    fused word share the whole word's span."""
    end: int
    text: str
    lemma: str | None
    """Dictionary form: psa -> pies."""
    lemma_id: str | None
    """Stable key "{lang}:{lemma}:{upos}", e.g. "pl:pies:NOUN". None for punctuation."""
    upos: Upos
    xpos: str | None
    """Language-specific tag. For Polish an NKJP tag like "subst:sg:gen:m2"; see
    skolia/pl/nkjp.py."""
    feats: Feats
    head: int | None
    """Index in the sentence's token list of the word this one depends on. None for the root."""
    deprel: Deprel | None
    """UD dependency relation to the head: obl, amod, case, nsubj, ..."""
    mwt: NotRequired[str]
    """Set when this token is part of a multi-word token (a fused word); holds the whole word."""
    candidates: NotRequired[list[Reading]]
    """All readings the dictionary knows for this form. Only present when there is more than one."""
    parser: NotRequired[Reading]
    """What the parser said, when it was replaced by the closest dictionary reading because
    the dictionary doesn't allow it (see reconcile.py), or by the case the governing verb
    requires (lang/pl/cases.py). Worth showing: one of them is wrong."""
    case_reason: NotRequired[CaseReason]
    """Why the word has its case, for words with a Case feature, when a rule explains it."""
    case_correction: NotRequired[CaseCorrection]
    """Set when the case was corrected by the governing verb's valency (lang/pl/cases.py)."""


class ExpressionDef(TypedDict):
    """Input: a multi-word expression to look for, as a sequence of lemmas."""

    id: str
    lemmas: list[str]


ExpressionMatch = TypedDict("ExpressionMatch", {"from": int, "to": int, "id": str})
"""Output: token indices (inclusive) where an expression matched.

Functional TypedDict syntax because "from" is a Python keyword.
"""


class Sentence(TypedDict):
    start: int
    """Offset into the source text in UTF-16 code units, as Token.start."""
    end: int
    tokens: list[Token]
    expressions: list[ExpressionMatch]


class Blob(TypedDict):
    schema: int
    """Version of this JSON shape."""
    analyzer: str
    """Plugin + library versions that produced it; a change means the blob can be regenerated."""
    lang: str
    hash: str
    """sha256 of the source text; the blob's storage key."""
    sentences: list[Sentence]
