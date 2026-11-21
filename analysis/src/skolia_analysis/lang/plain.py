"""The analyzer of a language whose parser's reading is the token's: no dictionary of
readings to check it against, so no candidates and no snapping (en, fr)."""

from collections.abc import Callable, Iterable
from dataclasses import dataclass

from ..blob import build
from ..parsed import ParsedSentence, Parser
from ..schema import Blob, ExpressionDef


def unchanged(parsed: Iterable[ParsedSentence]) -> Iterable[ParsedSentence]:
    return parsed


@dataclass(frozen=True, slots=True, kw_only=True)
class PlainAnalyzer:
    lang: str
    version: str
    """The plugin's version, in the analyzer's name."""
    parser: Parser
    expressions: tuple[ExpressionDef, ...] = ()
    preprocess: Callable[[Iterable[ParsedSentence]], Iterable[ParsedSentence]] = unchanged
    """What the language changes in the parse before the blob is built (fr: lemmas)."""

    @property
    def name(self) -> str:
        return f"{self.lang}/{self.version}+{self.parser.name}"

    def __call__(self, text: str) -> Blob:
        return self.assemble(text, self.parser(text))

    def assemble(self, text: str, parsed: Iterable[ParsedSentence]) -> Blob:
        return build(
            self.preprocess(parsed),
            lang=self.lang,
            analyzer=self.name,
            text=text,
            expressions=self.expressions,
        )
