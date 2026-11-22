"""What a language plugin provides. Each language is a package under lang/ (lang/pl), and
lang/__init__.py lists them. Code outside lang/ reaches a language only through this.

A language's built data (lexicon and anything else its plugin needs) sits in one directory:
{lang}.sqlite from skolia-build-lexicon, plus the plugin's own files.
"""

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .parsed import ParsedSentence, Parser
from .schema import Blob, ExpressionDef


@dataclass(frozen=True, slots=True)
class Options:
    snap: str | None
    """A reconcile.POLICIES name, or None to keep the parser's readings as they are."""
    candidates: bool = True
    """List every dictionary reading of each word; snapping needs them."""
    expressions: tuple[ExpressionDef, ...] = ()


class Analyzer(Protocol):
    @property
    def name(self) -> str:
        """The version of everything that shapes an analysis; goes into the blob. A
        document analysed under another name is out of date."""
        ...

    def __call__(self, text: str) -> Blob: ...

    def assemble(self, text: str, parsed: Iterable[ParsedSentence]) -> Blob:
        """The blob for text already parsed, so one slow parse can be reused."""
        ...


class LanguagePlugin(Protocol):
    @property
    def LANG(self) -> str:
        """ISO 639-1 code, e.g. "pl". Read-only so a module constant LANG = "pl" satisfies it."""
        ...

    @property
    def MODELS(self) -> Mapping[str, Callable[[], Parser]]:
        """Parser models by name; each callable loads one (slow, so call once)."""
        ...

    @property
    def DEFAULT_MODEL(self) -> str: ...

    @property
    def DEFAULT_SNAP(self) -> str | None:
        """Default reconcile policy, or None to keep the parser's readings."""
        ...

    def parser(self, model: str) -> Parser: ...

    def analyzer(self, parser: Parser, options: Options, data: Path | None) -> Analyzer:
        """data: the language's data directory, for the files the plugin uses besides the
        lexicon; None to analyse without them."""
        ...
