"""Shape of the lexicon entries and the per-document bundle JSON."""

from typing import Literal, NotRequired, TypedDict

from ..lang.pl.walenty.model import Schema
from ..schema import Aspect, Feats, Upos


class Example(TypedDict):
    text: str
    translation: NotRequired[str]


class Sense(TypedDict):
    gloss: str
    tags: list[str]
    """Wiktionary's labels: slang, dated, transitive, ..."""
    when: NotRequired[list[Feats]]
    """The sense applies to a token whose feats include any one of these, e.g. the dog
    sense of pies has [{"Gender": "Masc", "Animacy": "Nhum"}]. Absent: always applies."""
    examples: NotRequired[list[Example]]


type Derivation = Literal[
    "agent-noun",  # abolisher <- abolish
    "augmentative",  # psisko <- pies
    "diminutive",  # rubelek <- rubel
    "endearing",  # kotuś <- kot
    "feminine",  # pani <- pan
    "frequentative",  # chadzać <- chodzić
    "iterative",  # pokładać <- kłaść
    "masculine",  # wdowiec <- wdowa
    "noun-from-verb",  # pisanie <- pisać
    "perfective",  # zgolić <- golić
]


class AspectPartner(TypedDict):
    """robić <-> zrobić: the same action, the other aspect."""

    kind: Literal["aspect-partner"]
    lemma: str
    lemma_id: NotRequired[str]
    """The target's entry; absent when the lexicon has no entry with that lemma."""
    aspect: Aspect
    """The partner's."""


class DerivedFrom(TypedDict):
    kind: Literal["derived-from"]
    lemma: str
    lemma_id: NotRequired[str]
    how: Derivation


class VariantOf(TypedDict):
    """Another form of the same word: niechże, emphatic niech; bzikać, regional bzykać."""

    kind: Literal["variant-of"]
    lemma: str
    lemma_id: NotRequired[str]
    tags: list[str]
    """Wiktionary's labels for the variant, like a sense's: emphatic, regional, rare."""


type Relation = AspectPartner | DerivedFrom | VariantOf
type RelationKind = Literal["aspect-partner", "derived-from", "variant-of"]


class Form(TypedDict):
    form: str
    xpos: str
    feats: Feats


class Paradigm(TypedDict):
    homonym: str
    """Tells apart a lemma's tables with different forms, e.g. Morfeusz's Sm1 (pies: cop) vs
    Sm2 (pies: dog). Empty when the lemma has one table."""
    forms: list[Form]


type FormRow = tuple[str, list[int]]
"""A form and every feature set it has, as indices into Bundle.feats:
["psa", [3, 7]] is psa as genitive and as accusative. Listing each (form, feats) pair in
full made verb paradigms ~9x bigger: a participle declines for gender, number and case."""


class BundleParadigm(TypedDict):
    """To highlight a token's form, match its text and its feats minus PronType and ExtPos,
    which the sentence decides and paradigms leave out."""

    homonym: str
    forms: list[FormRow]


type Accent = Literal["UK", "US"]


class Pronunciation(TypedDict):
    ipa: str
    """In the International Phonetic Alphabet, phonemic: /ˈpjɛs/."""
    accents: NotRequired[list[Accent]]
    """Absent when Wiktionary gives it for every accent (all of Polish's)."""


class Recording(TypedDict):
    """A Wiktionary sound with a recording, as Kaikki gives it."""

    audio: str
    """Wikimedia Commons file name: De-frei.ogg. Its page,
    commons.wikimedia.org/wiki/File:<audio>, credits the speaker and gives the licence."""
    mp3_url: str
    tags: NotRequired[list[str]]
    """Where the speaker is from, as Wiktionary tags it: Germany, Berlin."""


class Entry(TypedDict):
    """A word as the lexicon serves it, whole: what the API's lookup returns, D1 stores
    and a bundle carries, built once by lexicon/entry.py."""

    lemma_id: str
    lemma: str
    upos: Upos
    grammar: Feats
    """What every form of the word has, from its paradigm and Wiktionary's tags: a verb's
    aspect, a noun's gender. Those tags are taken off its senses."""
    senses: list[Sense]
    """Its own, or for a word Wiktionary only names in another's entry, the senses of
    the words it's derived from (zgolić, a perfective of golić, means what golić does),
    without their examples or selectors."""
    relations: list[Relation]
    pronunciations: list[Pronunciation]
    """How the lemma is said."""
    paradigms: list[BundleParadigm]
    frames: list[Schema]
    """How the word combines with others (Walenty valency schemata), for a verb both
    with and without się (Schema.reflexive). Empty when Walenty lacks the word."""


type Match = Literal[
    "exact",  # same lemma and part of speech
    "other-pos",  # same lemma, the lexicon files it under another part of speech
    "lowercase",  # the lemma lowercased (Krakowski -> krakowski)
    "none",  # no senses; the entry has only the paradigm
]


BUNDLE_SCHEMA = 2
"""The bundle's JSON shape. Documents keep their bundle until ingest redoes them. Add a
field as NotRequired and bump BUNDLER_VERSION instead (pronunciations). Bump this only when
the shape changes; the reader treats a bundle of an older schema as one being redone.

2: entries are the lexicon's whole Entry (lemma_id, grammar, pronunciations, typed
relations, senses resolved), and match is gone."""

BUNDLER_VERSION = "6"
"""The bundle-making code's version (lexicon/bundle.py and the plugins' bundlers). Bump it
when a change gives different bundles for the same analysis and lexicon (the lookup
fallbacks, how paradigms are made). It's in every bundle's name, so a bump re-bundles each
document once; ingest reuses the analysis, so that costs a second or two a document."""


class Bundle(TypedDict):
    schema: int
    """BUNDLE_SCHEMA when it was made."""
    lang: str
    lexicon: str
    """Lexicon version: sources and their dates."""
    attribution: str
    entries: dict[str, Entry]
    """By lemma_id."""
    lookup: dict[str, str]
    """Token lemma_id -> entry lemma_id, only where they differ (other-pos, lowercase)."""
    feats: list[Feats]
    """Every distinct feature set in the paradigms, referred to by index from FormRow."""
    pronunciations: dict[str, list[Pronunciation]]
    """By pronunciation_key(word, upos), for each token's text Wiktionary has one for (a
    lemma's are on its entry). Words spelled alike can differ by part of speech (lead, the
    metal, is /lɛd/; the verb is /liːd/)."""
    recordings: dict[str, list[Recording]]
    """By pronunciation_key, like pronunciations. Apart from them because Wiktionary doesn't
    say which transcription a recording is of."""


def pronunciation_key(word: str, upos: Upos) -> str:
    """psa, NOUN -> psa:NOUN"""
    return f"{word}:{upos}"
