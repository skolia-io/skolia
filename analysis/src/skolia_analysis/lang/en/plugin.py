"""English language plugin: Stanza parses; the forms and meanings come from Wiktionary.

English inflects little, so there is no dictionary of readings to check the parser
against (no candidates, no snapping): the parser's reading is the token's.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from ...lexicon.entry import Extras
from ...parsed import Parser
from ...parsers.stanza_parser import StanzaParser
from ...plugin import Options
from ..plain import PlainAnalyzer
from .lexicon import Source

LANG = "en"
PLUGIN_VERSION = "0.2"

# Parser models, by name. Each loads on first use. Stanza's English models are trained on
# UD English EWT, GUM and other UD English treebanks ("combined"). Scores: EVALUATION.md.
MODELS: dict[str, Callable[[], Parser]] = {
    # ELECTRA-large transformer: most accurate, slowest
    "stanza-accurate": lambda: StanzaParser(LANG, "default_accurate"),
    # character language model: fastest
    "stanza": lambda: StanzaParser(LANG, "default"),
}
DEFAULT_MODEL = "stanza-accurate"
DEFAULT_SNAP: str | None = None


def parser(model: str = DEFAULT_MODEL) -> Parser:
    return MODELS[model]()


def analyzer(parser: Parser, options: Options, data: Path | None) -> PlainAnalyzer:
    """English uses nothing from data besides the lexicon, and has no candidate lookup:
    Options.candidates has no effect."""
    if options.snap is not None:
        raise ValueError(f"English has no candidates to snap to (snap {options.snap!r})")
    return PlainAnalyzer(
        lang=LANG, version=PLUGIN_VERSION, parser=parser, expressions=options.expressions
    )


def lexicon_source() -> Source:
    return Source()


def extras(data: Path | None) -> Extras:
    """Nothing: the paradigms are the lexicon's, from Wiktionary."""
    return Extras()
