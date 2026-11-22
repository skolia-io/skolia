"""Polish language plugin: a parser picks one reading in context, Morfeusz lists them all,
and Walenty says which cases verbs require."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path

from ... import reconcile
from ...blob import CandidateLookup, Language, build
from ...lexicon.entry import Frames, no_frames
from ...parsed import ParsedSentence, Parser
from ...parsers.combo_parser import ComboParser
from ...parsers.stanza_parser import StanzaParser
from ...plugin import Options
from ...schema import Blob, ExpressionDef, Reading, Token, Upos
from . import cases
from .lexicon import Source
from .morfeusz import MorfeuszCandidates
from .nkjp import VERB_FORM_CLASSES, tag_class
from .valency import Valency

LANG = "pl"
PLUGIN_VERSION = "0.9"

# Parser models, by name. Each loads on first use. All are trained on UD Polish PDB, whose
# conventions schema.py and the dictionary conversion assume. Scores: analysis/EVALUATION.md.
MODELS: dict[str, Callable[[], Parser]] = {
    # XLM-RoBERTa tagger + parser from IPI PAN (UD 2.18 naming): most accurate, ~3x slower
    # than stanza
    "combo": lambda: ComboParser("clarin-pl/combo-nlp-xlm-roberta-base-polish-pdb-ud2.18"),
    # Stanza with the HerBERT transformer: close to combo on parsing, behind on tagging
    "stanza-accurate": lambda: StanzaParser(LANG, "default_accurate"),
    # Stanza with a character language model: fastest, least accurate
    "stanza": lambda: StanzaParser(LANG, "default"),
}
# Both chosen on PDB dev with scripts/eval_ud.py (see EVALUATION.md). DEFAULT_SNAP keeps
# the parser's UPOS and takes the closest dictionary features and lemma when the parser's
# reading isn't one Morfeusz allows.
DEFAULT_MODEL = "combo"
DEFAULT_SNAP: str | None = "upos"

VALENCY_FILE = "pl-valency.json"
"""Walenty's frames in the data directory (skolia-build-valency)."""


def parser(model: str = DEFAULT_MODEL) -> Parser:
    return MODELS[model]()


def candidate_lookup() -> CandidateLookup:
    return MorfeuszCandidates()


def valency(data: Path | None) -> Valency | None:
    return Valency.load(data / VALENCY_FILE) if data is not None else None


def entry_upos(reading: Reading) -> Upos:
    """Participles and gerunds belong to the verb's lexicon entry: pl:robić:VERB."""
    if tag_class(reading["xpos"]) in VERB_FORM_CLASSES:
        return "VERB"
    return reading["upos"]


def expression_gap(token: Token) -> bool:
    """Clitics split off a fused word that expression matching steps over:
    the person ending in dałem (dał + em) and the conditional in dałbym (dał + by + m)."""
    xpos = token["xpos"] or ""
    is_person_ending = tag_class(xpos) == "aglt"
    is_conditional = token["lemma"] == "by" and token["upos"] == "AUX"
    return is_person_ending or is_conditional


@dataclass(frozen=True, slots=True, kw_only=True)
class PolishAnalyzer:
    parser: Parser
    candidates: CandidateLookup | None = None
    expressions: tuple[ExpressionDef, ...] = ()
    snap: str | None = DEFAULT_SNAP
    """A reconcile.POLICIES name, or None to keep the parser's readings as they are."""
    valency: Valency | None = None
    """Walenty's frames, to explain cases by what verbs require; without them, case
    reasons use only the tree."""
    correct_cases: bool = True
    """Let verb valency fix a case it rules out (only off to measure the correction)."""

    @property
    def name(self) -> str:
        name = f"{LANG}/{PLUGIN_VERSION}+{self.parser.name}+morfeusz-{version('morfeusz2')}"
        if self.snap:
            name += f"+snap-{self.snap}"
        if self.valency is not None:
            name += f"+{self.valency.version}"
            if not self.correct_cases:
                name += "+no-case-correction"
        return name

    def __call__(self, text: str) -> Blob:
        return self.assemble(text, self.parser(text))

    def assemble(self, text: str, parsed: Iterable[ParsedSentence]) -> Blob:
        language = Language(
            lang=LANG,
            candidates=self.candidates,
            snap=reconcile.POLICIES[self.snap] if self.snap else None,
            expression_gap=expression_gap,
            entry_upos=entry_upos,
            revise=self.revise,
        )
        return build(parsed, language, analyzer=self.name, text=text, expressions=self.expressions)

    def revise(self, tokens: list[Token]) -> None:
        cases.revise(tokens, self.valency, correct=self.correct_cases)


def analyzer(parser: Parser, options: Options, data: Path | None) -> PolishAnalyzer:
    """With data, case reasons and corrections use Walenty (VALENCY_FILE)."""
    return PolishAnalyzer(
        parser=parser,
        candidates=candidate_lookup() if options.candidates else None,
        expressions=options.expressions,
        snap=options.snap,
        valency=valency(data),
    )


def lexicon_source() -> Source:
    return Source()


def frames(data: Path | None) -> Frames:
    """With data, Walenty's."""
    walenty = valency(data)
    return walenty.frames if walenty is not None else no_frames
