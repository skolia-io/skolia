import json
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from skolia_analysis.lang.pl.walenty.parse import parse_schema
from skolia_analysis.lexicon import build, commons, entry, pronunciation, senses, store
from skolia_analysis.lexicon.entry import Row, no_frames
from skolia_analysis.lexicon.kaikki import KaikkiEntry, KaikkiSound
from skolia_analysis.lexicon.schema import (
    Derivation,
    Entry,
    Form,
    Paradigm,
    Pronunciation,
    Recording,
    Relation,
    Sense,
)
from skolia_analysis.lexicon.source import Converted, Pronounced
from skolia_analysis.schema import Aspect, Feats, Upos

MIGRATIONS = Path(__file__).resolve().parents[2] / "lexicon" / "migrations"

DOG: Sense = {"gloss": "dog", "tags": [], "when": [{"Gender": "Masc", "Animacy": "Nhum"}]}
COP: Sense = {"gloss": "cop", "tags": [], "when": [{"Gender": "Masc", "Animacy": "Hum"}]}


def test_merge_keeps_selectors_only_when_they_differ() -> None:
    entries = [
        Converted("pies", ("NOUN",), [DOG.copy()]),
        Converted("pies", ("NOUN",), [COP.copy()]),
        Converted("pani", ("NOUN",), [{"gloss": "lady", "tags": [], "when": [{"Gender": "Fem"}]}]),
    ]
    merged = build.merge(entries)
    assert [s.get("when") for s in merged["pies", "NOUN"].senses] == [
        DOG.get("when"),
        COP.get("when"),
    ]
    assert "when" not in merged["pani", "NOUN"].senses[0]
    assert merged["pani", "NOUN"].grammar == {"Gender": "Fem"}
    assert merged["pies", "NOUN"].grammar == {}


def test_merge_takes_grammar_tags_off_senses() -> None:
    entries = [
        Converted("robić", ("VERB",), [{"gloss": "to do", "tags": ["imperfective", "transitive"]}])
    ]
    merged = build.merge(entries, {"imperfective", "perfective"})
    assert merged["robić", "VERB"].senses[0]["tags"] == ["transitive"]


def test_entry_shares_feature_sets_and_groups_forms() -> None:
    gen: Feats = {"Case": "Gen", "Number": "Sing"}
    acc: Feats = {"Case": "Acc", "Number": "Sing"}
    forms: list[Form] = [
        {"form": "psa", "xpos": "subst:sg:gen:m2", "feats": gen},
        {"form": "psa", "xpos": "subst:sg:acc:m2", "feats": acc},
        {"form": "psu", "xpos": "subst:sg:dat:m2", "feats": {"Case": "Dat"}},
    ]
    row = Row("pl:pies:NOUN", "pies", "NOUN", [DOG], [], [{"homonym": "Sm2", "forms": forms}], {})
    feats = entry.FeatsTable()
    result = entry.make({}, row, no_frames, feats)
    compacted = result["paradigms"][0]["forms"]
    assert [(f, [feats.table[i] for i in ids]) for f, ids in compacted] == [
        ("psa", [gen, acc]),
        ("psu", [{"Case": "Dat"}]),
    ]
    assert result["grammar"] == {}
    assert result["frames"] == []

    strach = parse_schema("pies: pewny: : : : {np(gen)}", "noun")
    with_frames = entry.make(
        {},
        row,
        lambda lemma, upos: [strach] if (lemma, upos) == ("pies", "NOUN") else [],
        feats,
    )
    assert with_frames["frames"] == [strach]


def test_grammar_adds_what_every_form_has() -> None:
    forms: list[Form] = [
        {"form": "psa", "xpos": "subst:sg:gen:m2", "feats": {"Case": "Gen", "Gender": "Masc"}},
        {"form": "psem", "xpos": "subst:sg:inst:m2", "feats": {"Case": "Ins", "Gender": "Masc"}},
    ]
    row = Row("pl:pies:NOUN", "pies", "NOUN", [DOG], [], [{"homonym": "", "forms": forms}], {})
    made = entry.make({}, row, no_frames, entry.FeatsTable())
    assert made["grammar"] == {"Gender": "Masc"}


def test_commons_names_give_their_words() -> None:
    assert commons.word("pl", "LL-Q809 (pol)-Olaf-ósma.wav") == "ósma"
    assert commons.word("pl", "LL-Q809 (pol)-Jest Spoczko-écru.wav") == "écru"
    assert commons.word("pl", "LL-Q809 (pol)-Poemat-biało-czerwony.wav") == "biało-czerwony"
    assert commons.word("pl", "LL-Q809 (pol)-Poemat-à propos.wav") == "à propos"
    assert commons.word("pl", "Pl-pies.ogg") == "pies"
    assert commons.word("pl", "Pl-pies-2.ogg") == "pies"
    assert commons.word("pl", "Pl-biało-czerwony.ogg") == "biało-czerwony"
    assert commons.word("pl", "Polish flag.svg") is None


def test_commons_mp3_url_is_kaikkis() -> None:
    assert commons.mp3_url("LL-Q809 (pol)-KaMan-cukinię.wav") == (
        "https://upload.wikimedia.org/wikipedia/commons/transcoded/d/d5/"
        "LL-Q809_%28pol%29-KaMan-cukini%C4%99.wav/LL-Q809_%28pol%29-KaMan-cukini%C4%99.wav.mp3"
    )


def test_commons_recordings_are_lingua_libres_first() -> None:
    found = commons.recordings("pl", ["Pl-pies.ogg", "LL-Q809 (pol)-Olaf-pies.wav", "x.png"])
    assert [r["audio"] for r in found["pies"]] == ["LL-Q809 (pol)-Olaf-pies.wav", "Pl-pies.ogg"]
    assert list(found) == ["pies"]


def test_recordings_are_the_sounds_with_audio_each_file_once() -> None:
    sounds: list[KaikkiSound] = [
        {"ipa": "/fʁaɪ̯/"},
        {"audio": "De-frei.ogg", "mp3_url": "https://x/De-frei.ogg.mp3", "tags": ["Berlin"]},
        {"audio": "De-frei.ogg", "mp3_url": "https://x/De-frei.ogg.mp3"},
        {"audio": "De-frei2.ogg"},
    ]
    assert pronunciation.recordings(sounds) == [
        {"audio": "De-frei.ogg", "mp3_url": "https://x/De-frei.ogg.mp3", "tags": ["Berlin"]}
    ]


def test_pronunciations_merge_accents() -> None:
    uk: Pronunciation = {"ipa": "/ɹiːd/", "accents": ["UK"]}
    us: Pronunciation = {"ipa": "/ɹiːd/", "accents": ["US"]}
    assert pronunciation.merge([uk], [us, {"ipa": "/ɹɛd/"}]) == [
        {"ipa": "/ɹiːd/", "accents": ["UK", "US"]},
        {"ipa": "/ɹɛd/"},
    ]
    assert pronunciation.merge([uk], [{"ipa": "/ɹiːd/"}]) == [{"ipa": "/ɹiːd/"}]


def _finir(upos: Upos, senses: list[Sense]) -> Entry:
    return {
        "lemma_id": f"fr:finir:{upos}",
        "lemma": "finir",
        "upos": upos,
        "grammar": {},
        "senses": senses,
        "relations": [{"kind": "derived-from", "lemma": "missing", "how": "diminutive"}],
        "pronunciations": [],
        "recordings": [],
        "paradigms": [],
        "frames": [],
    }


def test_a_lexicon_file_reads_back_what_was_written(tmp_path: Path) -> None:
    path = tmp_path / "fr.sqlite"
    verb = _finir("VERB", [{"gloss": "to finish", "tags": []}])
    noun = _finir("NOUN", [])
    heard: Recording = {"audio": "fr-finir.ogg", "mp3_url": "https://x/a", "tags": ["France"]}
    said = store.to_json({"pronunciations": [{"ipa": "/fi.niʁ/"}], "recordings": []})
    commons_said = store.to_json({"pronunciations": [], "recordings": [heard]})
    contents = store.Contents(
        {"lang": "fr", "version": "test/1"},
        [
            store.EntryRow("fr:finir:NOUN", "finir", "NOUN", store.to_json(noun), 0),
            store.EntryRow("fr:finir:VERB", "finir", "VERB", store.to_json(verb), 1),
        ],
        [store.Edge("fr:finir:VERB", 0, "missing", None, "derived-from", '{"how": "diminutive"}')],
        [{"Number": "Sing"}],
        [store.AudioRow("finir", "VERB", said), store.AudioRow("finir", None, commons_said)],
    )
    store.write(path, MIGRATIONS, contents)

    lexicon = store.Lexicon(path)
    assert lexicon.meta() == {"lang": "fr", "version": "test/1"}
    assert lexicon.get("fr:finir:VERB") == verb
    assert lexicon.has_senses("fr:finir:VERB")
    assert not lexicon.has_senses("fr:finir:NOUN")
    assert lexicon.by_lemma("finir") == [verb, noun]
    assert lexicon.with_senses("finir") == [verb]
    assert lexicon.lowercase_with_senses("Finir") == [verb]
    assert list(lexicon.incoming("missing")) == [("fr:finir:VERB", verb["relations"][0])]
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT DISTINCT version FROM entry").fetchall() == [("test/1",)]
        assert db.execute("SELECT id, feature, value FROM featureset").fetchall() == [
            (0, "Number", "Sing")
        ]
        assert db.execute(
            "SELECT form, upos, data FROM form_pronunciation ORDER BY upos"
        ).fetchall() == [("finir", "", commons_said), ("finir", "VERB", said)]


GOLIĆ: list[Sense] = [
    {
        "gloss": "to shave",
        "tags": ["transitive"],
        "examples": [{"text": "Golę się codziennie rano."}],
    },
    {"gloss": "to down, to soak (to drink)", "tags": ["colloquial"]},
]


def _verb(lemma: str, aspect: Aspect) -> list[Paradigm]:
    forms: list[Form] = [
        {"form": lemma, "xpos": "inf", "feats": {"VerbForm": "Inf", "Aspect": aspect}},
        {"form": lemma[:-1] + "ł", "xpos": "praet", "feats": {"Tense": "Past", "Aspect": aspect}},
    ]
    return [{"homonym": "", "forms": forms}]


class VerbSource:
    """Polish-like: golić's senses, and forms generated, here a verb's infinitive and past,
    zgolić's perfective and the rest imperfective."""

    attribution = ""
    grammar_tags = ()
    version = ""

    def convert(self, entry: KaikkiEntry) -> Converted | None:
        if entry.get("word") != "golić":
            return None
        return Converted("golić", ("VERB",), [sense.copy() for sense in GOLIĆ])

    def pronounce(self, entry: KaikkiEntry) -> Pronounced | None:
        return None

    def paradigms(self, lemma: str, upos: Upos) -> list[Paradigm]:
        return _verb(lemma, "Perf" if lemma == "zgolić" else "Imp")

    def hand_entries(self) -> Iterable[Converted]:
        return ()


def test_a_derivative_without_senses_takes_its_bases_and_its_own_aspect(tmp_path: Path) -> None:
    derived = [{"word": "zgolić", "tags": ["perfective", "verb"]}]
    golić = {
        "word": "golić",
        "pos": "verb",
        "senses": [
            {"glosses": ["to shave"], "derived": derived},
            {"glosses": ["to down"], "derived": derived},
        ],
    }
    kaikki = tmp_path / "pl.jsonl"
    kaikki.write_text(json.dumps(golić, ensure_ascii=False) + "\n", encoding="utf-8")
    contents, _ = build.build("pl", VerbSource(), build.Inputs(kaikki))
    path = tmp_path / "pl.sqlite"
    store.write(path, MIGRATIONS, contents)

    lexicon = store.Lexicon(path)
    made = lexicon.get("pl:zgolić:VERB")
    assert made is not None
    assert not lexicon.has_senses("pl:zgolić:VERB")
    relation = {
        "kind": "derived-from",
        "lemma": "golić",
        "how": "perfective",
        "lemma_id": "pl:golić:VERB",
    }
    assert made["relations"] == [relation]
    assert list(lexicon.incoming("golić")) == [("pl:zgolić:VERB", relation)]
    assert made["grammar"] == {"Aspect": "Perf"}
    assert made["senses"] == [
        {"gloss": "to shave", "tags": ["transitive"]},
        {"gloss": "to down, to soak (to drink)", "tags": ["colloquial"]},
    ]


def test_aspect_partners_name_their_targets() -> None:
    ogolić = Converted(
        "ogolić",
        ("VERB",),
        [{"gloss": "to shave off", "tags": []}],
        [{"kind": "aspect-partner", "lemma": "golić", "aspect": "Imp"}],
    )
    rows = {row.lemma_id: row for row in build.rows("pl", VerbSource(), [ogolić])}
    assert rows["pl:ogolić:VERB"].relations == [
        {"kind": "aspect-partner", "lemma": "golić", "aspect": "Imp", "lemma_id": "pl:golić:VERB"}
    ]
    assert rows["pl:golić:VERB"].senses == []


def test_a_relation_to_a_spelling_of_several_parts_of_speech_takes_its_sources() -> None:
    """doggy, a noun, is from the noun dog; a verb from the verb; an adjective, with no
    adjective dog, from the noun."""

    def word(lemma: str, upos: Upos, relations: list[Relation]) -> Converted:
        return Converted(lemma, (upos,), [{"gloss": lemma, "tags": []}], relations)

    def from_dog(how: Derivation) -> list[Relation]:
        return [{"kind": "derived-from", "lemma": "dog", "how": how}]

    entries = [
        word("dog", "NOUN", []),
        word("dog", "VERB", []),
        word("doggy", "NOUN", from_dog("diminutive")),
        word("doggle", "VERB", from_dog("frequentative")),
        word("doggish", "ADJ", from_dog("endearing")),
    ]
    rows = {row.lemma_id: row for row in build.rows("en", VerbSource(), entries)}
    sources = ["en:doggy:NOUN", "en:doggle:VERB", "en:doggish:ADJ"]
    assert [rows[source].relations[0].get("lemma_id") for source in sources] == [
        "en:dog:NOUN",
        "en:dog:VERB",
        "en:dog:NOUN",
    ]


def test_relations_read_alt_of_and_take_genders_from_the_gloss() -> None:
    entry: KaikkiEntry = {
        "word": "nauczycielka",
        "pos": "noun",
        "senses": [
            {
                "glosses": ["female equivalent of nauczyciel"],
                "tags": ["feminine", "form-of"],
                "form_of": [{"word": "nauczyciel"}],
            },
            {
                "glosses": ["obsolete form of nauczycielica"],
                "tags": ["alt-of", "feminine", "obsolete"],
                "alt_of": [{"word": "nauczycielica"}],
            },
        ],
    }
    assert list(senses.relations(entry, (), {"feminine", "masculine"})) == [
        {"kind": "derived-from", "lemma": "nauczyciel", "how": "feminine"},
        {"kind": "variant-of", "lemma": "nauczycielica", "tags": ["obsolete"]},
    ]
