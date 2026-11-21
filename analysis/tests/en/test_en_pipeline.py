"""The English analyzer on hand-built parser output: from ParsedSentence to the analysis
blob, with no Stanza model."""

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from skolia_analysis.blob import SCHEMA
from skolia_analysis.ingest import cli
from skolia_analysis.ingest.schema import analysis_name
from skolia_analysis.ingest.worker import versions
from skolia_analysis.lang.en import plugin as en
from skolia_analysis.parsed import ParsedSentence, ParsedToken, ParsedWord, align
from skolia_analysis.plugin import Options
from skolia_analysis.schema import Blob, Deprel, ExpressionDef, Feats, Upos

MODEL = "test-model"
TEXT = "I can't find the café 🙂. She gave up."
EXPRESSIONS: tuple[ExpressionDef, ...] = ({"id": "en:give up", "lemmas": ["give", "up"]},)
OPTIONS = Options(None, expressions=EXPRESSIONS)


def word(
    text: str, lemma: str | None, upos: Upos, feats: Feats, head: int | None, deprel: Deprel
) -> ParsedWord:
    return ParsedWord(text, lemma, upos, None, feats, head, deprel)


def sentence(
    text: str, start: int, tokens: Sequence[tuple[str, tuple[ParsedWord, ...]]]
) -> ParsedSentence:
    """Tokens as (surface, words); a fused token's words needn't spell its surface
    (can't -> ca + n't)."""
    spans = align(text, [surface for surface, _ in tokens], start)
    return ParsedSentence(
        tuple(
            ParsedToken(surface, s, e, words)
            for (surface, words), (s, e) in zip(tokens, spans, strict=True)
        )
    )


def parse(text: str = TEXT) -> list[ParsedSentence]:
    return [
        sentence(
            text,
            0,
            [
                ("I", (word("I", "I", "PRON", {"Case": "Nom", "Person": "1"}, 2, "nsubj"),)),
                (
                    "can't",
                    (
                        word("ca", "can", "AUX", {"VerbForm": "Fin"}, 2, "aux"),
                        word("n't", "not", "PART", {"Polarity": "Neg"}, 2, "advmod"),
                    ),
                ),
                ("find", (word("find", "find", "VERB", {"VerbForm": "Inf"}, None, "root"),)),
                ("the", (word("the", "the", "DET", {"Definite": "Def"}, 4, "det"),)),
                ("café", (word("café", "café", "NOUN", {"Number": "Sing"}, 2, "obj"),)),
                ("🙂", (word("🙂", "🙂", "SYM", {}, 2, "discourse"),)),
                (".", (word(".", ".", "PUNCT", {}, 2, "punct"),)),
            ],
        ),
        sentence(
            text,
            25,
            [
                ("She", (word("She", "she", "PRON", {"Person": "3"}, 1, "nsubj"),)),
                ("gave", (word("gave", "give", "VERB", {"Tense": "Past"}, None, "root"),)),
                ("up", (word("up", "up", "ADP", {}, 1, "compound:prt"),)),
                (".", (word(".", ".", "PUNCT", {}, 1, "punct"),)),
            ],
        ),
    ]


@dataclass(frozen=True)
class FakeParser:
    """Stands in for Stanza: the parser isn't what's under test."""

    name: str
    sentences: list[ParsedSentence]

    def __call__(self, text: str) -> list[ParsedSentence]:
        return self.sentences


def assemble() -> Blob:
    return en.analyzer(FakeParser(MODEL, []), OPTIONS, None).assemble(TEXT, parse())


def test_tokens_have_utf16_offsets_lemma_ids_and_readings() -> None:
    blob = assemble()
    first, second = blob["sentences"]
    # 🙂 is past the BMP: two UTF-16 units, so everything after it moves by one
    assert (first["start"], first["end"]) == (0, 25)
    assert (second["start"], second["end"]) == (26, 38)
    assert [(t["text"], t["start"], t["end"]) for t in first["tokens"]] == [
        ("I", 0, 1),
        ("ca", 2, 7),
        ("n't", 2, 7),
        ("find", 8, 12),
        ("the", 13, 16),
        ("café", 17, 21),
        ("🙂", 22, 24),
        (".", 24, 25),
    ]
    assert [t["lemma_id"] for t in first["tokens"]] == [
        "en:I:PRON",
        "en:can:AUX",
        "en:not:PART",
        "en:find:VERB",
        "en:the:DET",
        "en:café:NOUN",
        None,
        None,
    ]
    i, ca, nt = first["tokens"][:3]
    assert "mwt" not in i
    assert ca.get("mwt") == nt.get("mwt") == "can't"
    assert (nt["upos"], nt["feats"], nt["head"], nt["deprel"]) == (
        "PART",
        {"Polarity": "Neg"},
        2,
        "advmod",
    )
    # No dictionary of readings for English: the parser's reading stands
    for sent in blob["sentences"]:
        for token in sent["tokens"]:
            assert "candidates" not in token
            assert "parser" not in token
    assert blob["lang"] == "en"
    assert blob["schema"] == SCHEMA


def test_expressions_match_lemmas() -> None:
    first, second = assemble()["sentences"]
    assert first["expressions"] == []
    assert second["expressions"] == [{"from": 1, "to": 2, "id": "en:give up"}]


def test_blob_names_its_analyzer() -> None:
    blob = assemble()
    assert blob["analyzer"] == f"en/{en.PLUGIN_VERSION}+{MODEL}"


def test_analyzer_parses_then_assembles() -> None:
    analyzer = en.analyzer(FakeParser(MODEL, parse()), OPTIONS, None)
    blob: Blob = analyzer(TEXT)
    assert analyzer.name == blob["analyzer"]
    assert blob == assemble()
    assert analyzer.assemble(TEXT, parse()) == blob


def test_analyzer_refuses_to_snap() -> None:
    with pytest.raises(ValueError, match="snap"):
        en.analyzer(FakeParser(MODEL, parse()), Options("nearest"), None)


def test_ingest_pipeline_publishes_the_analyzer_s_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setitem(en.MODELS, en.DEFAULT_MODEL, lambda: FakeParser(MODEL, parse()))
    analyzer = cli.analyzer("en", tmp_path)
    blob = analyzer(TEXT)
    assert blob["lang"] == "en"
    assert versions(analyzer) == {
        "analyzer": blob["analyzer"],
        "analysis": analysis_name(SCHEMA, blob["analyzer"]),
    }
