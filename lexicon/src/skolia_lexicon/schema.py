"""Shape of the lexicon entries served by the Worker."""

from typing import Literal, NotRequired, TypedDict

from skolia.pl.walenty.model import Schema
from skolia.ud import Aspect, Feats, Upos


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
"""A form and every feature set it has, as feature set IDs:
["psa", [3, 7]] is psa as genitive and as accusative. Listing each (form, feats) pair in
full made verb paradigms ~9x bigger: a participle declines for gender, number and case."""


class EntryParadigm(TypedDict):
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


class StoredEntry(TypedDict):
    """A whole word entry as lexicon/entry.py builds it and D1 stores it."""

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
    paradigms: list[EntryParadigm]
    frames: list[Schema]
    """How the word combines with others (Walenty valency schemata), for a verb both
    with and without się (Schema.reflexive). Empty when Walenty lacks the word."""


class Entry(StoredEntry):
    """An entry as the lexicon Worker serves it: with its lemma's audio, which the Worker
    looks up in form_pronunciation as it does any form's (lexicon-api/src/store.ts)."""

    pronunciations: list[Pronunciation]
    """How the lemma is said."""
    recordings: list[Recording]
