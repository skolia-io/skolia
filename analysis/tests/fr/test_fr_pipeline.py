"""The French analyzer on hand-built parser output: from ParsedSentence to the analysis
blob, with no Stanza model."""

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from skolia_analysis.blob import SCHEMA
from skolia_analysis.ingest import cli
from skolia_analysis.ingest.schema import analysis_name
from skolia_analysis.ingest.worker import versions
from skolia_analysis.lang.fr import plugin as fr
from skolia_analysis.parsed import ParsedSentence, ParsedToken, ParsedWord, align
from skolia_analysis.plugin import Options
from skolia_analysis.schema import Blob, Deprel, ExpressionDef, Feats, Upos

MODEL = "test-model"
TEXT = "J'aime ma mère. Il parle du café 😀."
EXPRESSIONS: tuple[ExpressionDef, ...] = ({"id": "fr:parler de", "lemmas": ["parler", "de"]},)
OPTIONS = Options(None, expressions=EXPRESSIONS)


def word(
    text: str, lemma: str | None, upos: Upos, feats: Feats, head: int | None, deprel: Deprel
) -> ParsedWord:
    return ParsedWord(text, lemma, upos, None, feats, head, deprel)


def sentence(
    text: str, start: int, tokens: Sequence[tuple[str, tuple[ParsedWord, ...]]]
) -> ParsedSentence:
    """Tokens as (surface, words); a fused token's words needn't spell its surface
    (du -> de + le)."""
    spans = align(text, [surface for surface, _ in tokens], start)
    return ParsedSentence(
        tuple(
            ParsedToken(surface, s, e, words)
            for (surface, words), (s, e) in zip(tokens, spans, strict=True)
        )
    )


def parse(text: str = TEXT) -> list[ParsedSentence]:
    """With GSD's lemmas, as Stanza gives them: moi for j', son for ma, lui for il."""
    ma: Feats = {"Gender": "Fem", "Number": "Sing", "Poss": "Yes", "PronType": "Prs"}
    ma["Person[psor]"] = "1"
    ma["Number[psor]"] = "Sing"
    return [
        sentence(
            text,
            0,
            [
                (
                    "J'",
                    (word("J'", "moi", "PRON", {"Person": "1", "PronType": "Prs"}, 1, "nsubj"),),
                ),
                ("aime", (word("aime", "aimer", "VERB", {"Mood": "Ind"}, None, "root"),)),
                ("ma", (word("ma", "son", "DET", ma, 3, "det"),)),
                ("mère", (word("mère", "mère", "NOUN", {"Gender": "Fem"}, 1, "obj"),)),
                (".", (word(".", ".", "PUNCT", {}, 1, "punct"),)),
            ],
        ),
        sentence(
            text,
            16,
            [
                (
                    "Il",
                    (word("Il", "lui", "PRON", {"Person": "3", "PronType": "Prs"}, 1, "nsubj"),),
                ),
                ("parle", (word("parle", "parler", "VERB", {"Mood": "Ind"}, None, "root"),)),
                (
                    "du",
                    (
                        word("de", "de", "ADP", {}, 4, "case"),
                        word("le", "le", "DET", {"Definite": "Def"}, 4, "det"),
                    ),
                ),
                ("café", (word("café", "café", "NOUN", {"Gender": "Masc"}, 1, "obl:arg"),)),
                ("😀", (word("😀", "😀", "SYM", {}, 1, "discourse"),)),
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
    return fr.analyzer(FakeParser(MODEL, []), OPTIONS, None).assemble(TEXT, parse())


def test_tokens_have_utf16_offsets_lemma_ids_and_readings() -> None:
    blob = assemble()
    first, second = blob["sentences"]
    assert (first["start"], first["end"]) == (0, 15)
    # 😀 is past the BMP: two UTF-16 units, so the period after it moves by one
    assert (second["start"], second["end"]) == (16, 36)
    assert [(t["text"], t["start"], t["end"]) for t in second["tokens"]] == [
        ("Il", 16, 18),
        ("parle", 19, 24),
        ("de", 25, 27),
        ("le", 25, 27),
        ("café", 28, 32),
        ("😀", 33, 35),
        (".", 35, 36),
    ]
    de, le = second["tokens"][2:4]
    assert de.get("mwt") == le.get("mwt") == "du"
    assert (le["upos"], le["feats"], le["head"], le["deprel"]) == (
        "DET",
        {"Definite": "Def"},
        4,
        "det",
    )
    assert [t["lemma_id"] for t in second["tokens"]] == [
        "fr:il:PRON",
        "fr:parler:VERB",
        "fr:de:ADP",
        "fr:le:DET",
        "fr:café:NOUN",
        None,
        None,
    ]
    for sent in blob["sentences"]:
        for token in sent["tokens"]:
            assert "candidates" not in token
            assert "parser" not in token
    assert blob["lang"] == "fr"
    assert blob["schema"] == SCHEMA


def test_pronouns_and_possessives_get_their_dictionary_lemmas() -> None:
    first, second = assemble()["sentences"]
    j, _, ma, mere, _ = first["tokens"]
    assert (j["lemma"], j["lemma_id"]) == ("je", "fr:je:PRON")
    assert (ma["lemma"], ma["lemma_id"]) == ("mon", "fr:mon:DET")
    # The features stay as the parser gave them
    assert ma["feats"].get("Person[psor]") == "1"
    assert (mere["lemma"], mere["lemma_id"]) == ("mère", "fr:mère:NOUN")
    assert second["tokens"][0]["lemma"] == "il"


def test_expressions_match_inside_a_fused_word() -> None:
    first, second = assemble()["sentences"]
    assert first["expressions"] == []
    assert second["expressions"] == [{"from": 1, "to": 2, "id": "fr:parler de"}]


def test_blob_names_its_analyzer() -> None:
    blob = assemble()
    assert blob["analyzer"] == f"fr/{fr.PLUGIN_VERSION}+{MODEL}"


def test_analyzer_parses_then_assembles() -> None:
    analyzer = fr.analyzer(FakeParser(MODEL, parse()), OPTIONS, None)
    blob: Blob = analyzer(TEXT)
    assert analyzer.name == blob["analyzer"]
    assert blob == assemble()
    assert analyzer.assemble(TEXT, parse()) == blob
    assert blob["sentences"][0]["tokens"][0]["lemma"] == "je"


def test_analyzer_refuses_to_snap() -> None:
    with pytest.raises(ValueError, match="snap"):
        fr.analyzer(FakeParser(MODEL, parse()), Options("nearest"), None)


def test_ingest_pipeline_publishes_the_analyzer_s_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setitem(fr.MODELS, fr.DEFAULT_MODEL, lambda: FakeParser(MODEL, parse()))
    analyzer = cli.analyzer("fr", tmp_path)
    blob = analyzer(TEXT)
    assert blob["lang"] == "fr"
    assert versions(analyzer) == {
        "analyzer": blob["analyzer"],
        "analysis": analysis_name(SCHEMA, blob["analyzer"]),
    }
