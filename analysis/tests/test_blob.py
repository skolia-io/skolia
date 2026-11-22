from skolia.lemma import lemma_id
from skolia_analysis.blob import Language, build, match_expressions, utf16_offsets, utf16_slice
from skolia_analysis.parsed import ParsedSentence, ParsedToken, ParsedWord
from skolia_analysis.schema import ExpressionDef

DAC_SOBIE_RADE: list[ExpressionDef] = [
    {"id": "pl:dać sobie radę", "lemmas": ["dać", "siebie", "rada"]}
]


def test_lemma_id() -> None:
    assert lemma_id("pl", "pies", "NOUN") == "pl:pies:NOUN"
    assert lemma_id("pl", ".", "PUNCT") is None


def test_expression_matches_inflected_forms_by_lemma() -> None:
    lemmas = ["ona", "dać", "siebie", "rada", "."]
    assert match_expressions(lemmas, DAC_SOBIE_RADE) == [
        {"from": 1, "to": 3, "id": "pl:dać sobie radę"}
    ]


def test_expression_no_match() -> None:
    exprs: list[ExpressionDef] = [{"id": "x", "lemmas": ["w", "ogóle"]}]
    assert match_expressions(["nie", "wiem"], exprs) == []


def test_expression_steps_over_gaps() -> None:
    lemmas = ["dać", "być", "siebie", "rada", "."]
    gaps = [False, True, False, False, False]
    assert match_expressions(lemmas, DAC_SOBIE_RADE) == []
    assert match_expressions(lemmas, DAC_SOBIE_RADE, gaps) == [
        {"from": 0, "to": 3, "id": "pl:dać sobie radę"}
    ]


def test_offsets_are_utf16_past_the_bmp() -> None:
    text = "😀 🐕a b"
    tokens = [("😀", 0, 1), ("🐕a", 2, 4), ("b", 5, 6)]
    sentence = ParsedSentence(
        tuple(
            ParsedToken(
                surface, start, end, (ParsedWord(surface, None, "X", None, {}, None, None),)
            )
            for surface, start, end in tokens
        )
    )
    blob = build([sentence], Language(lang="pl"), analyzer="test", text=text)
    spans = [(t["start"], t["end"]) for t in blob["sentences"][0]["tokens"]]
    assert spans == [(0, 2), (3, 6), (7, 8)]
    assert (blob["sentences"][0]["start"], blob["sentences"][0]["end"]) == (0, 8)
    assert [utf16_slice(text, start, end) for start, end in spans] == ["😀", "🐕a", "b"]


def test_utf16_offsets() -> None:
    assert utf16_offsets("") == [0]
    assert utf16_offsets("ę😀a") == [0, 1, 3, 4]
