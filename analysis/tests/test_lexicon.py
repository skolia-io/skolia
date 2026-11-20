import json
import sqlite3
from pathlib import Path

from skolia_analysis.lang.pl.walenty.parse import parse_schema
from skolia_analysis.lexicon import build, bundle, commons, d1_export, pronunciation, store
from skolia_analysis.lexicon.kaikki import KaikkiSound
from skolia_analysis.lexicon.schema import Form, Paradigm, Pronunciation, Recording, Sense
from skolia_analysis.lexicon.source import Converted
from skolia_analysis.schema import Blob, Feats, Token, Upos

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


def test_parse_lemma_id_with_separator_in_lemma() -> None:
    assert bundle.parse_lemma_id("pl:a:b:NOUN") == ("pl", "a:b", "NOUN")


def test_resolve_falls_back(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    rows = [
        store.Row("pl:by:PART", "by", "PART", [{"gloss": "would", "tags": []}], [], []),
        store.Row(
            "pl:krakowski:ADJ", "krakowski", "ADJ", [{"gloss": "of Kraków", "tags": []}], [], []
        ),
        # the same spelling as a name: the adjective lowercased wins over it
        store.Row(
            "pl:Krakowski:PROPN", "Krakowski", "PROPN", [{"gloss": "a surname", "tags": []}], [], []
        ),
    ]
    store.write(path, rows, {})
    lexicon = store.Lexicon(path)
    assert bundle.resolve(lexicon, "pl:by:PART")[1] == "exact"
    assert bundle.resolve(lexicon, "pl:by:AUX")[1] == "other-pos"
    found, match = bundle.resolve(lexicon, "pl:Krakowski:ADJ")
    assert (found and found.lemma_id, match) == ("pl:krakowski:ADJ", "lowercase")
    assert bundle.resolve(lexicon, "pl:xyzzy:NOUN") == (None, "none")


def test_resolve_prefers_the_closest_part_of_speech(tmp_path: Path) -> None:
    path = tmp_path / "en.sqlite"
    senses: list[Sense] = [{"gloss": f"sense {i}", "tags": []} for i in range(3)]
    rows = [
        store.Row("en:must:NOUN", "must", "NOUN", senses, [], []),
        store.Row("en:must:VERB", "must", "VERB", senses[:1], [], []),
    ]
    store.write(path, rows, {})
    found, match = bundle.resolve(store.Lexicon(path), "en:must:AUX")
    assert (found and found.lemma_id, match) == ("en:must:VERB", "other-pos")


def test_bundle_shares_feature_sets_and_groups_forms(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    store.write(
        path, [store.Row("pl:pies:NOUN", "pies", "NOUN", [DOG], [], [])], {"version": "test/1"}
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

    token: Token = {
        "start": 0,
        "end": 3,
        "text": "psa",
        "lemma": "pies",
        "lemma_id": "pl:pies:NOUN",
        "upos": "NOUN",
        "xpos": None,
        "feats": gen,
        "head": None,
        "deprel": "root",
    }
    blob: Blob = {
        "schema": 2,
        "analyzer": "test",
        "lang": "pl",
        "hash": "",
        "sentences": [{"start": 0, "end": 3, "tokens": [token], "expressions": []}],
    }
    result = bundle.make(blob, store.Lexicon(path), paradigms)
    forms = result["entries"]["pl:pies:NOUN"]["paradigms"][0]["forms"]
    assert [(f, [result["feats"][i] for i in ids]) for f, ids in forms] == [
        ("psa", [gen, acc]),
        ("psu", [{"Case": "Dat"}]),
    ]
    assert result["match"] == {"pl:pies:NOUN": "exact"}
    assert result["entries"]["pl:pies:NOUN"]["frames"] == []

    strach = parse_schema("pies: pewny: : : : {np(gen)}", "noun")
    with_frames = bundle.make(
        blob,
        store.Lexicon(path),
        paradigms,
        lambda lemma, upos: [strach] if (lemma, upos) == ("pies", "NOUN") else [],
    )
    assert with_frames["entries"]["pl:pies:NOUN"]["frames"] == [strach]


def test_bundle_pronounces_tokens_and_lemmas(tmp_path: Path) -> None:
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
    store.write(path, [], {"version": "test/1"}, lambda: said)
    lexicon = store.Lexicon(path)
    assert bundle.pronounce(lexicon, "Lead", "NOUN") == [{"ipa": "/lɛd/"}]
    assert bundle.pronounce(lexicon, "lead", "VERB") == [{"ipa": "/liːd/"}]
    assert bundle.pronounce(lexicon, "be", "AUX") == [{"ipa": "/biː/"}]
    assert bundle.pronounce(lexicon, "xyzzy", "NOUN") == []
    assert bundle.pronounce(lexicon, "read", "VERB") == []
    assert bundle.record(lexicon, "read", "VERB") == [read]
    assert bundle.record(lexicon, "lead", "NOUN") == []

    token: Token = {
        "start": 0,
        "end": 3,
        "text": "led",
        "lemma": "lead",
        "lemma_id": "en:lead:VERB",
        "upos": "VERB",
        "xpos": None,
        "feats": {},
        "head": None,
        "deprel": "root",
    }
    blob: Blob = {
        "schema": 2,
        "analyzer": "test",
        "lang": "en",
        "hash": "",
        "sentences": [{"start": 0, "end": 3, "tokens": [token], "expressions": []}],
    }
    made = bundle.make(blob, lexicon)
    assert made.get("pronunciations") == {
        "led:VERB": [{"ipa": "/lɛd/"}],
        "lead:VERB": [{"ipa": "/liːd/"}],
    }
    assert made.get("recordings") == {"lead:VERB": [lead]}


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


def test_bundle_falls_back_to_commons_recordings(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    wiktionary: Recording = {"audio": "Pl-kot.ogg", "mp3_url": "https://x/Pl-kot.ogg.mp3"}
    psa: Recording = {"audio": "LL-psa.wav", "mp3_url": "https://x/LL-psa.wav.mp3"}
    kot: Recording = {"audio": "LL-kot.wav", "mp3_url": "https://x/LL-kot.wav.mp3"}
    said = [
        store.PronunciationRow("kot", "NOUN", [{"ipa": "/kɔt/"}], [wiktionary]),
        store.PronunciationRow("pies", "NOUN", [{"ipa": "/ˈpjɛs/"}], []),
    ]
    store.write(path, [], {"version": "test/1"}, lambda: said, {"psa": [psa], "kot": [kot]})
    lexicon = store.Lexicon(path)
    assert bundle.record(lexicon, "kot", "NOUN") == [wiktionary]
    assert bundle.record(lexicon, "Psa", "NOUN") == [psa]
    assert bundle.record(lexicon, "pies", "NOUN") == []


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


def test_d1_export_has_d1_schema_pronunciations_compact_paradigms_and_feature_rows(
    tmp_path: Path,
) -> None:
    path = tmp_path / "pl.sqlite"
    said = [store.PronunciationRow("pies", "NOUN", [{"ipa": "/pjɛs/"}], [])]
    store.write(
        path,
        [
            store.Row(
                "pl:pies:NOUN",
                "pies",
                "NOUN",
                [DOG],
                [{"type": "derived-from", "lemma": "piesek", "note": "x"}],
                [],
            )
        ],
        {"lang": "pl", "version": "test/1"},
        lambda: said,
    )
    gen: Feats = {"Case": "Gen", "Number": "Sing"}
    acc: Feats = {"Case": "Acc", "Number": "Sing"}

    def paradigms(_lemma: str, _upos: Upos) -> list[Paradigm]:
        forms: list[Form] = [
            {"form": "psa", "xpos": "subst:sg:gen:m2", "feats": gen},
            {"form": "psa", "xpos": "subst:sg:acc:m2", "feats": acc},
        ]
        return [{"homonym": "", "forms": forms}]

    out = tmp_path / "pl.d1.sqlite"
    migrations = Path(__file__).resolve().parents[2] / "api" / "lexicon-migrations"
    assert d1_export.build(store.Lexicon(path), paradigms, migrations, out) == 1
    db = sqlite3.connect(out)
    version = f"test/1+d1-{d1_export.EXPORT_VERSION}"
    assert dict(db.execute("SELECT key, value FROM meta")) == {"lang": "pl", "version": version}
    stored, pronunciations, paradigm = db.execute(
        "SELECT version, pronunciations, paradigms FROM entry WHERE upos IS NOT NULL"
    ).fetchone()
    assert stored == version
    assert db.execute("SELECT lemma_id, upos, senses FROM entry WHERE upos IS NULL").fetchall() == [
        ("pl:piesek:", None, "[]")
    ]
    assert db.execute("SELECT * FROM relation").fetchall() == [
        ("pl:pies:NOUN", version, 0, "pl:piesek:", "derived-from", "x", None)
    ]
    assert json.loads(pronunciations) == [{"ipa": "/pjɛs/"}]
    assert json.loads(paradigm) == [{"homonym": "", "forms": [["psa", [0, 1]]]}]
    assert db.execute(
        "SELECT id, feature, value FROM featureset WHERE version = ? ORDER BY id, feature",
        (version,),
    ).fetchall() == [
        (0, "Case", "Gen"),
        (0, "Number", "Sing"),
        (1, "Case", "Acc"),
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
        [{"type": "derived-from", "lemma": "missing"}],
        [
            {
                "homonym": "",
                "forms": [
                    {"form": "finis", "xpos": "", "feats": {"Number": "Sing"}},
                    {"form": "finissons", "xpos": "", "feats": {"Number": "Plur"}},
                ],
            }
        ],
    )
    said: list[Pronunciation] = [{"ipa": "fi.niʁ", "accents": []}]
    heard: list[Recording] = [
        {"audio": "fr-finir.ogg", "mp3_url": "https://example.org/a", "tags": ["France"]}
    ]
    store.write(
        path,
        [row],
        {},
        lambda: [store.PronunciationRow("finir", "VERB", said, heard)],
        {"finir": heard},
    )
    lexicon = store.Lexicon(path)
    assert lexicon.get(row.lemma_id) == row
    assert lexicon.pronunciations("finir") == {"VERB": said}
    assert lexicon.recordings("finir") == {"VERB": heard}
    assert lexicon.word_recordings("finir") == heard
    assert lexicon.by_lemma("missing") == []
    assert list(lexicon.incoming("missing")) == [(row.lemma_id, row.relations[0])]
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT target_id FROM relation").fetchone() == ("fr:missing:",)
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


GOLIĆ = store.Row(
    "pl:golić:VERB",
    "golić",
    "VERB",
    [
        {
            "gloss": "to shave",
            "tags": ["imperfective"],
            "examples": [{"text": "Golę się codziennie rano."}],
        },
        {"gloss": "to down, to soak (to drink)", "tags": ["colloquial", "imperfective"]},
    ],
    [],
    [],
)


def test_derivative_takes_the_sense_it_was_listed_under(tmp_path: Path) -> None:
    path = tmp_path / "pl.sqlite"
    glosses = ("to down, to soak (to drink)",)
    store.write(
        path,
        [GOLIĆ],
        {"version": "test/1"},
        derivatives=[store.VerbDerivative("pl", "golić", "zgolić", glosses)],
    )
    lexicon = store.Lexicon(path)
    derived, match = bundle.resolve(lexicon, "pl:zgolić:VERB")
    assert match == "none"
    assert derived is not None and derived.senses == []
    assert derived.relations == [
        {
            "type": "derived-from",
            "lemma": "golić",
            "note": "perfective derivative",
            "lemma_id": "pl:golić:VERB",
            "sense_indexes": [1],
        }
    ]
    token: Token = {
        "start": 0,
        "end": 6,
        "text": "zgolił",
        "lemma": "zgolić",
        "lemma_id": "pl:zgolić:VERB",
        "upos": "VERB",
        "xpos": None,
        "feats": {},
        "head": None,
        "deprel": "root",
    }
    blob: Blob = {
        "schema": 2,
        "analyzer": "test",
        "lang": "pl",
        "hash": "",
        "sentences": [{"start": 0, "end": 6, "tokens": [token], "expressions": []}],
    }
    made = bundle.make(blob, lexicon)
    assert list(made["entries"]) == ["pl:zgolić:VERB", "pl:golić:VERB"]
    assert made["entries"]["pl:golić:VERB"]["senses"] == GOLIĆ.senses
    assert list(lexicon.incoming("golić")) == [
        (
            derived.lemma_id,
            {"type": "derived-from", "lemma": "golić", "note": "perfective derivative"},
        )
    ]
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT evidence, target_senses FROM relation").fetchone() == (
            '[["to down, to soak (to drink)"]]',
            "[1]",
        )
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_unmatched_evidence_names_no_senses_and_relations_name_their_targets(
    tmp_path: Path,
) -> None:
    path = tmp_path / "pl.sqlite"
    ogolić = store.Row(
        "pl:ogolić:VERB",
        "ogolić",
        "VERB",
        [{"gloss": "to shave off", "tags": []}],
        [{"type": "aspect-partner", "lemma": "golić", "note": "imperfective"}],
        [],
    )
    store.write(
        path,
        [GOLIĆ, ogolić],
        {},
        derivatives=[store.VerbDerivative("pl", "golić", "zgolić", ("elsewhere",))],
    )
    lexicon = store.Lexicon(path)
    derived = lexicon.get("pl:zgolić:VERB")
    assert derived is not None
    assert "sense_indexes" not in derived.relations[0]
    found = lexicon.get("pl:ogolić:VERB")
    assert found is not None
    assert found.relations == [{**ogolić.relations[0], "lemma_id": "pl:golić:VERB"}]
