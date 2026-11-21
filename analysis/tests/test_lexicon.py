import json
import sqlite3
from pathlib import Path

from skolia_analysis.lang.pl.walenty.parse import parse_schema
from skolia_analysis.lexicon import build, commons, d1_export, entry, pronunciation, store
from skolia_analysis.lexicon.entry import Extras
from skolia_analysis.lexicon.kaikki import KaikkiSound
from skolia_analysis.lexicon.schema import (
    Form,
    Paradigm,
    Pronunciation,
    Recording,
    Sense,
)
from skolia_analysis.lexicon.source import Converted
from skolia_analysis.schema import Aspect, Feats, Upos

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


def test_entry_shares_feature_sets_and_groups_forms(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    store.write(
        path,
        store.Contents(
            {"version": "test/1"}, [store.Row("pl:pies:NOUN", "pies", "NOUN", [DOG], [], [], {})]
        ),
    )
    gen: Feats = {"Case": "Gen", "Number": "Sing"}
    acc: Feats = {"Case": "Acc", "Number": "Sing"}

    def paradigms(_lemma: str, _upos: Upos) -> list[Paradigm]:
        forms: list[Form] = [
            {"form": "psa", "xpos": "subst:sg:gen:m2", "feats": gen},
            {"form": "psa", "xpos": "subst:sg:acc:m2", "feats": acc},
            {"form": "psu", "xpos": "subst:sg:dat:m2", "feats": {"Case": "Dat"}},
        ]
        return [{"homonym": "Sm2", "forms": forms}]

    lexicon = store.Lexicon(path)
    row = next(lexicon.rows())
    features: list[Feats] = []
    feats = entry.FeatsTable(features)
    result = entry.make(lexicon, row, Extras(paradigms), feats)
    forms = result["paradigms"][0]["forms"]
    assert [(f, [features[i] for i in ids]) for f, ids in forms] == [
        ("psa", [gen, acc]),
        ("psu", [{"Case": "Dat"}]),
    ]
    assert result["grammar"] == {}
    assert result["frames"] == []

    strach = parse_schema("pies: pewny: : : : {np(gen)}", "noun")
    with_frames = entry.make(
        lexicon,
        row,
        Extras(
            paradigms, lambda lemma, upos: [strach] if (lemma, upos) == ("pies", "NOUN") else []
        ),
        feats,
    )
    assert with_frames["frames"] == [strach]


def test_pronunciation_fallbacks(tmp_path: Path) -> None:
    path = tmp_path / "en.sqlite"
    lead: Recording = {"audio": "En-lead.ogg", "mp3_url": "https://x/En-lead.ogg.mp3"}
    read: Recording = {"audio": "En-read.ogg", "mp3_url": "https://x/En-read.ogg.mp3"}
    said = [
        store.PronunciationRow("lead", "NOUN", [{"ipa": "/lɛd/"}], []),
        store.PronunciationRow("lead", "VERB", [{"ipa": "/liːd/"}], [lead]),
        store.PronunciationRow("led", "VERB", [{"ipa": "/lɛd/"}], []),
        store.PronunciationRow("be", "VERB", [{"ipa": "/biː/"}], []),
        store.PronunciationRow("read", "VERB", [], [read]),
    ]
    store.write(path, store.Contents({"version": "test/1"}, pronunciations=said))
    lexicon = store.Lexicon(path)
    assert entry.pronounce(lexicon, "Lead", "NOUN") == [{"ipa": "/lɛd/"}]
    assert entry.pronounce(lexicon, "lead", "VERB") == [{"ipa": "/liːd/"}]
    assert entry.pronounce(lexicon, "be", "AUX") == [{"ipa": "/biː/"}]
    assert entry.pronounce(lexicon, "xyzzy", "NOUN") == []
    assert entry.pronounce(lexicon, "read", "VERB") == []
    assert entry.record(lexicon, "read", "VERB") == [read]
    assert entry.record(lexicon, "lead", "NOUN") == []


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


def test_record_falls_back_to_commons_recordings(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    wiktionary: Recording = {"audio": "Pl-kot.ogg", "mp3_url": "https://x/Pl-kot.ogg.mp3"}
    psa: Recording = {"audio": "LL-psa.wav", "mp3_url": "https://x/LL-psa.wav.mp3"}
    kot: Recording = {"audio": "LL-kot.wav", "mp3_url": "https://x/LL-kot.wav.mp3"}
    said = [
        store.PronunciationRow("kot", "NOUN", [{"ipa": "/kɔt/"}], [wiktionary]),
        store.PronunciationRow("pies", "NOUN", [{"ipa": "/ˈpjɛs/"}], []),
    ]
    store.write(
        path,
        store.Contents(
            {"version": "test/1"},
            pronunciations=said,
            word_recordings={"psa": [psa], "kot": [kot]},
        ),
    )
    lexicon = store.Lexicon(path)
    assert entry.record(lexicon, "kot", "NOUN") == [wiktionary]
    assert entry.record(lexicon, "Psa", "NOUN") == [psa]
    assert entry.record(lexicon, "pies", "NOUN") == []


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


def test_d1_export_stores_whole_entries_relations_and_feature_rows(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    said = [store.PronunciationRow("pies", "NOUN", [{"ipa": "/pjɛs/"}], [])]
    store.write(
        path,
        store.Contents(
            {"lang": "pl", "version": "test/1"},
            [
                store.Row(
                    "pl:pies:NOUN",
                    "pies",
                    "NOUN",
                    [DOG],
                    [{"kind": "variant-of", "lemma": "piesek", "tags": ["rare"]}],
                    [],
                    {},
                )
            ],
            said,
        ),
    )
    gen: Feats = {"Case": "Gen", "Number": "Sing", "Gender": "Masc"}
    acc: Feats = {"Case": "Acc", "Number": "Sing", "Gender": "Masc"}

    def paradigms(_lemma: str, _upos: Upos) -> list[Paradigm]:
        forms: list[Form] = [
            {"form": "psa", "xpos": "subst:sg:gen:m2", "feats": gen},
            {"form": "psa", "xpos": "subst:sg:acc:m2", "feats": acc},
        ]
        return [{"homonym": "", "forms": forms}]

    out = tmp_path / "pl.d1.sqlite"
    migrations = Path(__file__).resolve().parents[2] / "lexicon" / "migrations"
    assert d1_export.build(store.Lexicon(path), Extras(paradigms), migrations, out) == 1
    db = sqlite3.connect(out)
    version = f"test/1+d1-{d1_export.EXPORT_VERSION}"
    assert dict(db.execute("SELECT key, value FROM meta")) == {"lang": "pl", "version": version}
    stored, lemma, upos, lower, senses, data = db.execute(
        "SELECT version, lemma, upos, lemma_lower, sense_count, data FROM entry"
    ).fetchone()
    assert (lower, senses) == ("pies", 1)
    audio = db.execute(
        "SELECT data FROM form_pronunciation WHERE form = ? AND version = ? AND upos = ?",
        ("pies", version, "NOUN"),
    ).fetchone()
    assert json.loads(audio[0]) == {"pronunciations": [{"ipa": "/pjɛs/"}], "recordings": []}
    assert (stored, lemma, upos) == (version, "pies", "NOUN")
    assert json.loads(data) == {
        "lemma_id": "pl:pies:NOUN",
        "lemma": "pies",
        "upos": "NOUN",
        "grammar": {"Gender": "Masc"},
        "senses": [DOG],
        "relations": [{"kind": "variant-of", "lemma": "piesek", "tags": ["rare"]}],
        "pronunciations": [{"ipa": "/pjɛs/"}],
        "recordings": [],
        "paradigms": [{"homonym": "", "forms": [["psa", [0, 1]]]}],
        "frames": [],
    }
    assert db.execute("SELECT * FROM relation").fetchall() == [
        ("pl:pies:NOUN", version, 0, "piesek", None, "variant-of", '{"tags": ["rare"]}')
    ]
    assert db.execute(
        "SELECT id, feature, value FROM featureset WHERE version = ? ORDER BY id, feature",
        (version,),
    ).fetchall() == [
        (0, "Case", "Gen"),
        (0, "Gender", "Masc"),
        (0, "Number", "Sing"),
        (1, "Case", "Acc"),
        (1, "Gender", "Masc"),
        (1, "Number", "Sing"),
    ]


def test_normalized_lexicon_preserves_nested_values_and_incoming_links(tmp_path: Path) -> None:
    path = tmp_path / "lexicon.sqlite"
    row = store.Row(
        "fr:finir:VERB",
        "finir",
        "VERB",
        [
            {
                "gloss": "to finish",
                "tags": ["transitive", "formal"],
                "when": [{"VerbForm": "Inf"}, {"Number": "Sing"}],
                "examples": [{"text": "finir le travail", "translation": "finish the work"}],
            },
            {"gloss": "to end", "tags": []},
        ],
        [{"kind": "derived-from", "lemma": "missing", "how": "diminutive"}],
        [
            {
                "homonym": "",
                "forms": [
                    {"form": "finis", "xpos": "", "feats": {"Number": "Sing"}},
                    {"form": "finissons", "xpos": "", "feats": {"Number": "Plur"}},
                ],
            }
        ],
        {"VerbForm": "Fin"},
    )
    said: list[Pronunciation] = [{"ipa": "fi.niʁ", "accents": []}]
    heard: list[Recording] = [
        {"audio": "fr-finir.ogg", "mp3_url": "https://example.org/a", "tags": ["France"]}
    ]
    store.write(
        path,
        store.Contents(
            {},
            [row],
            [store.PronunciationRow("finir", "VERB", said, heard)],
            {"finir": heard},
        ),
    )
    lexicon = store.Lexicon(path)
    assert lexicon.get(row.lemma_id) == row
    assert lexicon.pronunciations("finir") == {"VERB": said}
    assert lexicon.recordings("finir") == {"VERB": heard}
    assert lexicon.word_recordings("finir") == heard
    assert lexicon.by_lemma("missing") == []
    assert list(lexicon.incoming("missing")) == [(row.lemma_id, row.relations[0])]
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT target_lemma, target_id FROM relation").fetchone() == (
            "missing",
            None,
        )
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


GOLIĆ = store.Row(
    "pl:golić:VERB",
    "golić",
    "VERB",
    [
        {
            "gloss": "to shave",
            "tags": ["transitive"],
            "examples": [{"text": "Golę się codziennie rano."}],
        },
        {"gloss": "to down, to soak (to drink)", "tags": ["colloquial"]},
    ],
    [],
    [],
    {},
)


def _verb(lemma: str, aspect: Aspect) -> list[Paradigm]:
    forms: list[Form] = [
        {"form": lemma, "xpos": "inf", "feats": {"VerbForm": "Inf", "Aspect": aspect}},
        {"form": lemma[:-1] + "ł", "xpos": "praet", "feats": {"Tense": "Past", "Aspect": aspect}},
    ]
    return [{"homonym": "", "forms": forms}]


def test_a_derivative_without_senses_takes_its_bases_and_its_own_aspect(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    store.write(
        path,
        store.Contents(
            {"version": "test/1"},
            [GOLIĆ],
            derivatives=[
                store.VerbDerivative("pl", "golić", "zgolić"),
                store.VerbDerivative("pl", "golić", "zgolić"),
            ],
        ),
    )
    lexicon = store.Lexicon(path)
    derived = lexicon.get("pl:zgolić:VERB")
    assert derived is not None and derived.senses == []
    assert derived.relations == [
        {"kind": "derived-from", "lemma": "golić", "how": "perfective", "lemma_id": "pl:golić:VERB"}
    ]
    assert list(lexicon.incoming("golić")) == [(derived.lemma_id, derived.relations[0])]

    extras = Extras(lambda lemma, _upos: _verb(lemma, "Perf" if lemma == "zgolić" else "Imp"))
    made = entry.make(lexicon, derived, extras, entry.FeatsTable([]))
    assert made["grammar"] == {"Aspect": "Perf"}
    assert made["senses"] == [
        {"gloss": "to shave", "tags": ["transitive"]},
        {"gloss": "to down, to soak (to drink)", "tags": ["colloquial"]},
    ]
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_an_entry_borrows_senses_from_its_base(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    derivatives = [store.VerbDerivative("pl", "golić", "zgolić")]
    store.write(path, store.Contents({"version": "test/1"}, [GOLIĆ], derivatives=derivatives))
    lexicon = store.Lexicon(path)
    row = lexicon.get("pl:zgolić:VERB")
    assert row is not None
    made = entry.make(lexicon, row, Extras(), entry.FeatsTable([]))
    assert [sense["gloss"] for sense in made["senses"]] == [
        "to shave",
        "to down, to soak (to drink)",
    ]


def test_aspect_partners_name_their_targets(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    ogolić = store.Row(
        "pl:ogolić:VERB",
        "ogolić",
        "VERB",
        [{"gloss": "to shave off", "tags": []}],
        [{"kind": "aspect-partner", "lemma": "golić", "aspect": "Imp"}],
        [],
        {},
    )
    store.write(path, store.Contents({}, [GOLIĆ, ogolić]))
    found = store.Lexicon(path).get("pl:ogolić:VERB")
    assert found is not None
    assert found.relations == [{**ogolić.relations[0], "lemma_id": "pl:golić:VERB"}]
