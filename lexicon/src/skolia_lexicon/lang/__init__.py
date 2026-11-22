"""Each language's conversion of Kaikki's entries (lang/{lang}.py), and its words' valency
frames."""

from pathlib import Path
from typing import Literal, assert_never

from skolia.pl.valency import VALENCY_FILE, Valency

from ..entry import Frames, no_frames
from ..source import LexiconSource
from . import en, fr, pl

type Lang = Literal["en", "fr", "pl"]
LANGS: tuple[Lang, ...] = ("en", "fr", "pl")


def source(lang: Lang) -> LexiconSource:
    match lang:
        case "en":
            return en.Source()
        case "fr":
            return fr.Source()
        case "pl":
            return pl.Source()
        case _:
            assert_never(lang)


def frames(lang: Lang, data: Path | None) -> Frames:
    """With data, the language's data directory, its valency lexicon's frames (Polish:
    Walenty's, VALENCY_FILE); English and French have none."""
    match lang:
        case "en" | "fr":
            return no_frames
        case "pl":
            return Valency.load(data / VALENCY_FILE).frames if data is not None else no_frames
        case _:
            assert_never(lang)
