"""French language plugin: Stanza parses; the forms and meanings come from Wiktionary.

As for English, there is no dictionary of readings to check the parser against (no
candidates, no snapping): the parser's reading is the token's.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from ...parsed import Parser
from ...parsers.stanza_parser import StanzaParser
from ...plugin import Options
from ..plain import PlainAnalyzer
from .lemmas import relemmatize

LANG = "fr"
PLUGIN_VERSION = "0.3"

# Parser models, by name. Each loads on first use. Stanza's French models are trained on
# UD French GSD and the other UD French treebanks ("combined"). Scores: EVALUATION.md.
MODELS: dict[str, Callable[[], Parser]] = {
    # CamemBERT-large transformer: most accurate, slowest. In batches of 1000 words, a
    # 20,000-character text peaks at 3.5 GiB instead of 5.7 (EVALUATION.md)
    "stanza-accurate": lambda: StanzaParser(LANG, "default_accurate", batch_words=1000),
    # character language model: fastest
    "stanza": lambda: StanzaParser(LANG, "default"),
}
DEFAULT_MODEL = "stanza-accurate"
DEFAULT_SNAP: str | None = None


def parser(model: str = DEFAULT_MODEL) -> Parser:
    return MODELS[model]()


def analyzer(parser: Parser, options: Options, data: Path | None) -> PlainAnalyzer:
    """French uses nothing from data besides the lexicon, and has no candidate lookup:
    Options.candidates has no effect."""
    if options.snap is not None:
        raise ValueError(f"French has no candidates to snap to (snap {options.snap!r})")
    return PlainAnalyzer(
        lang=LANG,
        version=PLUGIN_VERSION,
        parser=parser,
        expressions=options.expressions,
        preprocess=relemmatize,
    )
