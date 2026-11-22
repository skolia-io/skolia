"""Universal Dependencies (UD) labels: parts of speech, dependency relations, morphological
features, and a word form's reading. The label sets are the union of what the parsers can
output: UD Polish PDB, UD English EWT and the labels in Stanza's French models (UD French GSD
and the other French treebanks). Extend them when adding a language. The analysis checks
parser output against these types at runtime (skolia_analysis/ud.py).
"""

from typing import Literal, TypedDict

type Upos = Literal[
    "ADJ",  # adjective
    "ADP",  # adposition (preposition)
    "ADV",  # adverb
    "AUX",  # auxiliary verb
    "CCONJ",  # coordinating conjunction
    "DET",  # determiner: ten, który, mój
    "INTJ",  # interjection
    "NOUN",  # noun
    "NUM",  # numeral
    "PART",  # particle
    "PRON",  # pronoun
    "PROPN",  # proper noun
    "PUNCT",  # punctuation
    "SCONJ",  # subordinating conjunction
    "SYM",  # symbol
    "VERB",  # verb
    "X",  # other
]

type Deprel = Literal[
    "acl",  # adnominal clause: a clause modifying a noun
    "acl:cmp",  # adnominal clause, comparative
    "acl:relcl",  # adnominal clause, relative clause: dom, który kupiłem
    "advcl",  # adverbial clause modifier: gdy przyszedł, ...
    "advcl:cmp",  # adverbial clause modifier, comparative
    "advcl:cleft",  # adverbial clause modifier, cleft: the clause of c'est ... qui/que
    "advcl:relcl",  # adverbial clause modifier, relative clause: ..., co mnie zdziwiło
    "advmod",  # adverbial modifier: szybko biegać
    "advmod:arg",  # adverbial modifier, argument: one the verb requires, czuć się dobrze
    "advmod:cmp",  # adverbial modifier, comparative: with a comparative clause
    "advmod:emph",  # adverbial modifier, emphasizing: nawet, właśnie
    "advmod:neg",  # adverbial modifier, negation: nie
    "amod",  # adjectival modifier: stary pies
    "amod:cmp",  # adjectival modifier, comparative: with a comparative clause
    "amod:flat",  # adjectival modifier, flat: inside a name, Morze Bałtyckie
    "appos",  # appositional modifier: Warszawa, stolica Polski
    "aux",  # auxiliary: będę robić
    "aux:caus",  # auxiliary, causative: faire in faire construire
    "aux:clitic",  # auxiliary, clitic: the person ending -em in zrobiłem, -eś in byłeś
    "aux:cnd",  # auxiliary, conditional: by in zrobiłby
    "aux:imp",  # auxiliary, imperative: niech
    "aux:pass",  # auxiliary, passive: został zbudowany
    "aux:tense",  # auxiliary, tense: avoir or être forming a compound tense, a mangé
    "case",  # case marking: a preposition, do domu
    "cc",  # coordinating conjunction: i, ale
    "cc:preconj",  # coordinating conjunction, preconjunct: albo ... albo, zarówno ... jak i
    "ccomp",  # clausal complement: wiem, że przyjdzie
    "ccomp:cleft",  # clausal complement, cleft: required by the pronoun to
    "ccomp:obj",  # clausal complement, object: a clausal object of a verb
    "compound",  # compound: ice cream, phone book
    "compound:prt",  # compound, particle: the particle of a phrasal verb, give up
    "conj",  # conjunct: second and later items of a coordination, ryż i pszenica
    "cop",  # copula: jest in jest lekarzem
    "csubj",  # clausal subject: kto pyta, nie błądzi
    "csubj:outer",  # clausal subject, outer: the clausal counterpart of nsubj:outer
    "csubj:pass",  # clausal subject, passive: of a passive verb
    "dep",  # unspecified dependency: when nothing else fits
    "dep:comp",  # unspecified dependency, complement
    "det",  # determiner: ten dom
    "det:numgov",  # determiner, numeral governing?: governs the noun's case, wiele osób
    "det:nummod",  # determiner, numeric modifier: a quantifier that agrees with the noun's case
    "det:poss",  # determiner, possessive: mój dom
    "det:predet",  # determiner, predeterminer: before another determiner, all the books
    "discourse",  # discourse element: outside the sentence's structure
    "discourse:intj",  # discourse element, interjection: och
    "dislocated",  # dislocated element: a fronted or postposed phrase, that guy, I like him
    "dislocated:mod",  # dislocated element, modifier
    "dislocated:obj",  # dislocated element, object: ce livre, je l'ai lu
    "dislocated:obl",  # dislocated element, oblique
    "dislocated:subj",  # dislocated element, subject: moi, je pense
    "expl",  # expletive: a word with no meaning of its own, it in it is raining, there is
    "expl:comp",  # expletive, complement: a reflexive object pronoun, se in il se lave
    "expl:pass",  # expletive, passive: se in a passive, ça se vend bien
    "expl:pv",  # expletive, pronominal verb: się that belongs to the verb, bać się
    "expl:subj",  # expletive, subject: il in il pleut
    "fixed",  # fixed multiword expression: w związku z
    "flat",  # flat multiword expression: a name, Jan Kowalski
    "flat:foreign",  # flat multiword expression, foreign: a foreign phrase
    "flat:name",  # flat multiword expression, name: Jean Dupont
    "goeswith",  # goes with: a word wrongly split in two, with the second part, some times
    "iobj",  # indirect object: dać bratu książkę
    "iobj:agent",  # indirect object, agent: the doer under a causative, faire lire à Paul
    "list",  # list: items without conjunctions
    "mark",  # marker: a subordinating conjunction introducing a clause, że, gdy
    "nmod",  # nominal modifier: a noun modifying another noun
    "nmod:appos",  # nominal modifier, appositional
    "nmod:arg",  # nominal modifier, argument: a noun a noun requires
    "nmod:cmp",  # nominal modifier, comparative
    "nmod:desc",  # nominal modifier, descriptor: a title before a name, Mr. Magoo
    "nmod:flat",  # nominal modifier, flat: a noun inside a name
    "nmod:poss",  # nominal modifier, possessive: jego dom
    "nmod:pred",  # nominal modifier, predicative: after bycie, bycie lekarzem
    "nmod:unmarked",  # nominal modifier, unmarked: no preposition, any day this week, $5 a share
    "nsubj",  # nominal subject
    "nsubj:caus",  # nominal subject, causative: the doer under faire, Paul in faire partir Paul
    "nsubj:outer",  # nominal subject, outer: of a clause predicate, the thing is to keep calm
    "nsubj:pass",  # nominal subject, passive: dom został zbudowany
    "nummod",  # numeric modifier: a numeral that agrees with the noun, dwa psy
    "nummod:flat",  # numeric modifier, flat: a numeral inside a name
    "nummod:gov",  # numeric modifier, governing: governs the noun's case, pięć psów
    "obj",  # object: mam czas
    "obj:agent",  # object, agent: the doer under a causative, as an object
    "obj:lvc",  # object, light verb construction: the noun of prendre une décision
    "obl",  # oblique nominal: a noun phrase that isn't a core argument, do domu
    "obl:agent",  # oblique nominal, agent: of a passive verb, przez brata
    "obl:arg",  # oblique nominal, argument: one the verb requires, myśleć o tobie
    "obl:cmp",  # oblique nominal, comparative: wyższy od brata
    "obl:mod",  # oblique nominal, modifier: one the verb doesn't require, dans la rue
    "obl:orphan",  # oblique nominal, orphan: its noun is left out
    "obl:unmarked",  # oblique nominal, unmarked: no preposition, I left yesterday
    "orphan",  # orphan: dependent of a left-out head, ja piję kawę, a on herbatę
    "parataxis",  # parataxis: a clause loosely placed next to another
    "parataxis:insert",  # parataxis, insertion?: a parenthetical, moim zdaniem
    "parataxis:parenth",  # parataxis, parenthetical: an aside in brackets or dashes
    "parataxis:obj",  # parataxis, object: direct speech
    "punct",  # punctuation
    "reparandum",  # reparandum: a word the speaker corrected later (spoken language)
    "root",  # root: head of the sentence
    "vocative",  # vocative: the person addressed, Kasiu!
    "xcomp",  # open clausal complement: a clause without its own subject, chcę spać
    "xcomp:cleft",  # open clausal complement, cleft: required by the pronoun to
    "xcomp:pred",  # open clausal complement, predicative: wydaje się miły
    "xcomp:subj",  # open clausal complement, subject: an infinitive or adverbial phrase as subject
]

type Yes = Literal["Yes"]
type Case = Literal[
    "Nom",  # nominative: kto? co?
    "Gen",  # genitive: kogo? czego?
    "Dat",  # dative: komu? czemu?
    "Acc",  # accusative: kogo? co?
    "Ins",  # instrumental: kim? czym?
    "Loc",  # locative: o kim? o czym?
    "Voc",  # vocative: Kasiu!
]
type Number = Literal[
    "Sing",  # singular
    "Plur",  # plural
    "Ptan",  # plurale tantum: a noun that only has plural forms (drzwi, nożyczki)
]
type Gender = Literal[
    "Masc",  # masculine
    "Fem",  # feminine
    "Neut",  # neuter
]
type Animacy = Literal[
    "Hum",  # human: student
    "Nhum",  # non-human: an animal, pies
    "Inan",  # inanimate: stół
]
"""Masculine only."""
type Person = Literal[
    "0",  # zero person: the impersonal -no/-to form, zrobiono
    "1",  # first person: robię
    "2",  # second person: robisz
    "3",  # third person: robi
]
type Aspect = Literal[
    "Imp",  # imperfective: robić
    "Perf",  # perfective: zrobić
]
type Tense = Literal[
    "Past",  # past
    "Pres",  # present
    "Fut",  # future
    "Imp",  # imperfect: je mangeais
]
type Mood = Literal[
    "Ind",  # indicative: robisz
    "Imp",  # imperative: rób
    "Sub",  # subjunctive: if I were you
    "Cnd",  # conditional: je mangerais
]
type VerbForm = Literal[
    "Fin",  # finite: robię
    "Inf",  # infinitive: robić
    "Part",  # participle: robiony, robiący
    "Conv",  # converb: the adverbial participle, robiąc
    "Ger",  # gerund: the English -ing form used as a noun or participle, swimming is fun
    "Vnoun",  # verbal noun: robienie
]
type Voice = Literal[
    "Act",  # active
    "Pass",  # passive
]
type Degree = Literal[
    "Pos",  # positive: dobry
    "Cmp",  # comparative: lepszy
    "Sup",  # superlative: najlepszy
]
type Polarity = Literal[
    "Pos",  # positive
    "Neg",  # negative
]
type PronType = Literal[
    "Prs",  # personal: ja, ty
    "Dem",  # demonstrative: ten, tamten
    "Rel",  # relative: który
    "Int",  # interrogative: kto, co
    "Ind",  # indefinite: ktoś, coś
    "Tot",  # total: wszystko, każdy
    "Neg",  # negative: nic, nikt
    "Art",  # article: the, a
    "Emp",  # emphatic: the reflexive used for emphasis, I did it myself
    "Rcp",  # reciprocal: each other
    "Exc",  # exclamative: quel in quel dommage !
]
type Variant = Literal[
    "Short",  # short form: w, go, mi
    "Long",  # long form: we, jego, mnie
]
type PrepCase = Literal[
    "Pre",  # prepositional: the pronoun form used after a preposition, niego
    "Npr",  # non-prepositional: the form used without one, jego
]
type NumType = Literal[
    "Card",  # cardinal: pięć
    "Ord",  # ordinal: piąty
    "Sets",  # sets: the collective numeral, dwoje
    "Frac",  # fraction: half, third
    "Mult",  # multiplicative: twice, double
]
type NumForm = Literal[
    "Word",  # word: pięć
    "Digit",  # digit: 5
    "Roman",  # Roman: V
    "Combi",  # combined: digits and a suffix, 5th, 1990s
]
type AdpType = Literal[
    "Prep",  # preposition: before its noun, do domu
    "Post",  # postposition: after its noun, dwa lata temu
]
type ConjType = Literal[
    "Comp",  # comparing: niż, jak
    "Pred",  # predicative: jako
    "Oper",  # operator: a mathematical one, plus
]
type PartType = Literal[
    "Int",  # interrogative: czy
    "Mod",  # modal?
]
type VerbType = Literal[
    "Quasi",  # quasi-verb?: no person or aspect, trzeba, można
    "Mod",  # modal?: winien, powinien
]
type PunctType = Literal[
    "Peri",  # period: .
    "Comm",  # comma: ,
    "Dash",  # dash, en or em
    "Quot",  # quotation mark: „
    "Brck",  # bracket: (
    "Qest",  # question mark: ?
    "Colo",  # colon: :
    "Excl",  # exclamation mark: !
    "Semi",  # semicolon: ;
    "Slsh",  # slash: /
    "Elip",  # ellipsis: …
]
type PunctSide = Literal[
    "Ini",  # initial: ( „
    "Fin",  # final: ) ”
]
type Polite = Literal[
    "Depr",  # depreciative: a derogatory form of a masculine human noun
]
type Definite = Literal[
    "Def",  # definite: the
    "Ind",  # indefinite: a
]
type Style = Literal[
    "Arch",  # archaic: thee
    "Coll",  # colloquial: gonna
    "Expr",  # expressive: emotional or emphatic, sooo
    "Slng",  # slang
    "Vrnc",  # vernacular: nonstandard, ain't
]
type ExtPos = Upos
"""UPOS of a multi-word unit this word heads, e.g. ADP for "w związku z"."""

Feats = TypedDict(
    "Feats",
    {
        "Abbr": Yes,
        "AdpType": AdpType,
        "Animacy": Animacy,
        "Aspect": Aspect,
        "Case": Case,
        "ConjType": ConjType,
        "Definite": Definite,
        "Degree": Degree,
        "Emph": Literal["Yes", "No"],
        "ExtPos": ExtPos,
        "Foreign": Yes,
        "Gender": Gender,
        "Hyph": Yes,
        "Mood": Mood,
        "NumForm": NumForm,
        "NumType": NumType,
        "Number": Number,
        "Number[psor]": Literal["Sing", "Plur"],
        "PartType": PartType,
        "Person": Person,
        "Person[psor]": Literal["1", "2", "3"],
        "Polarity": Polarity,
        "Polite": Polite,
        "Poss": Yes,
        "PrepCase": PrepCase,
        "PronType": PronType,
        "PunctSide": PunctSide,
        "PunctType": PunctType,
        "Reflex": Yes,
        "Style": Style,
        "Tense": Tense,
        "Typo": Yes,
        "Variant": Variant,
        "VerbForm": VerbForm,
        "VerbType": VerbType,
        "Voice": Voice,
    },
    total=False,
)
"""UD morphological features. Every key is optional; a word only has the ones that apply.

Functional TypedDict syntax because "Number[psor]" (possessor's number: mój vs nasz) is not
a Python identifier. Person[psor] is the possessor's person (mon, ton, son); Emph marks an
emphatic form (French moi-même, Emph=Yes).
"""


class Reading(TypedDict):
    """One reading of a word form: a dictionary candidate, or what the parser said."""

    lemma: str
    upos: Upos
    xpos: str
    """Language-specific tag for exactly this reading, e.g. "subst:sg:gen:m2"."""
    feats: Feats
