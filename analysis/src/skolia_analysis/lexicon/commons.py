"""Recordings of words from Wikimedia Commons, for words English Wiktionary has none for.

English Wiktionary links recordings for only a handful of Polish words, but Commons has
about 120,000 Polish ones: Lingua Libre's (LL-Q809 (pol)-Olaf-ósma.wav) and Polish
Wiktionary's (Pl-pies.ogg). Each file's name gives its word, so a snapshot of the
categories' file names is enough; it is an input like Kaikki's extract, pinned in
inputs.sha256, since the categories grow. Most files are CC BY-SA; each file's page,
commons.wikimedia.org/wiki/File:<audio>, credits the speaker and gives the licence.
"""

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Iterator, Mapping
from pathlib import Path
from typing import Any, Final

from .schema import Recording

API: Final = "https://commons.wikimedia.org/w/api.php"
USER_AGENT: Final = "lexicon-build/0.1 (Commons category listing)"
"""Wikimedia turns away generic agents such as Python-urllib's."""

CATEGORIES: Final[Mapping[str, tuple[str, ...]]] = {
    "pl": ("Lingua Libre pronunciation-pol", "Polish pronunciation"),
}
"""Each language's categories, their files only: a subcategory such as Polish
pronunciation of names holds what tokens rarely are."""

_LINGUA_LIBRE: Final[Mapping[str, str]] = {"pl": "LL-Q809 (pol)-"}
"""A Lingua Libre file is LL-<Wikidata language> (<ISO 639-3>)-<speaker>-<word>.wav."""

_WIKTIONARY: Final[Mapping[str, re.Pattern[str]]] = {
    # Pl-pies.ogg, Pl-Brzesko-2.ogg (a second take), Pl-Auschwitz-Birkenau.ogg. Affixes
    # (Pl-naj-.ogg, Pl--acz.ogg) are left out: no token is one
    "pl": re.compile(r"^Pl-(?P<word>[^-]+(?:-[^-\d][^-]*)*)(?:-\d+)?\.(?:ogg|oga|wav)$"),
}


def fetch(lang: str, out: Path) -> int:
    """Writes the categories' file names, sorted, one per line; returns how many."""
    names = sorted({name for category in CATEGORIES[lang] for name in _files(category)})
    out.write_text("".join(f"{name}\n" for name in names), encoding="utf-8")
    return len(names)


def _files(category: str) -> Iterator[str]:
    """File names without the File: prefix, 500 a request."""
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": f"Category:{category}",
        "cmtype": "file",
        "cmlimit": "500",
        "format": "json",
        "formatversion": "2",
    }
    cont: dict[str, str] = {}
    while True:
        page = _get(f"{API}?{urllib.parse.urlencode(params | cont)}")
        for member in page["query"]["categorymembers"]:
            yield member["title"].removeprefix("File:")
        if "continue" not in page:
            return
        cont = {
            "cmcontinue": page["continue"]["cmcontinue"],
            "continue": page["continue"]["continue"],
        }


def _get(url: str) -> dict[str, Any]:
    """Waits as long as a 429's Retry-After says, as Wikimedia asks."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for _ in range(20):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(int(e.headers.get("Retry-After", "30")))
    raise RuntimeError(f"still rate-limited after 20 tries: {url}")


def word(lang: str, name: str) -> str | None:
    """The word a file records, or None for a name this doesn't parse."""
    if name.startswith(prefix := _LINGUA_LIBRE[lang]):
        stem = name.removeprefix(prefix).rsplit(".", 1)[0]
        # The speaker's name can't be told from a hyphenated word by the name alone, but
        # Lingua Libre's speakers' names rarely have a hyphen and words often do
        # (biało-czerwony), so the speaker ends at the first
        _, sep, said = stem.partition("-")
        return said if sep and said else None
    if match := _WIKTIONARY[lang].match(name):
        return match["word"]
    return None


def mp3_url(name: str) -> str:
    """Commons' mp3 of a file, as Kaikki gives it: under the md5 of the name with
    underscores for spaces."""
    file = name.replace(" ", "_")
    digest = hashlib.md5(file.encode()).hexdigest()
    quoted = urllib.parse.quote(file)
    return (
        "https://upload.wikimedia.org/wikipedia/commons/transcoded/"
        f"{digest[0]}/{digest[:2]}/{quoted}/{quoted}.mp3"
    )


def recordings(lang: str, names: Iterable[str]) -> dict[str, list[Recording]]:
    """By word as the file names spell it; Lingua Libre's first, as they're the clearer
    recordings, then by name."""
    found: dict[str, list[Recording]] = {}
    prefix = _LINGUA_LIBRE[lang]
    for name in sorted(names, key=lambda n: (not n.startswith(prefix), n)):
        if (said := word(lang, name)) is None:
            continue
        found.setdefault(said, []).append({"audio": name, "mp3_url": mp3_url(name)})
    return found


def read(path: Path) -> list[str]:
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]
