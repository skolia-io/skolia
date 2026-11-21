"""Read and write CoNLL-U.

CoNLL-U is the plain-text format UD treebanks are published in: one word per line, 10
tab-separated columns (id, form, lemma, upos, xpos, feats, head, deprel, deps, misc).
Lines with a range id like "3-4" are multi-word tokens: the surface form that the
following words were split from (zrobiłem -> zrobił + em).

Writing our blobs as CoNLL-U lets standard UD tools (e.g. the CoNLL 2018 evaluation
script) score them.
"""

from collections.abc import Iterator
from dataclasses import dataclass, field
from itertools import groupby
from pathlib import Path

from .blob import utf16_slice
from .schema import Blob, Token

EMPTY = "_"


def _feats(token: Token) -> str:
    pairs = sorted((f"{k}={v}" for k, v in token["feats"].items()), key=str.lower)
    return "|".join(pairs) or EMPTY


def _word_line(id_: int, word: Token, misc: str) -> str:
    head = 0 if word["head"] is None else word["head"] + 1
    columns = [
        str(id_),
        word["text"],
        word["lemma"] or EMPTY,
        word["upos"],
        word["xpos"] or EMPTY,
        _feats(word),
        str(head),
        word["deprel"] or EMPTY,
        EMPTY,
        misc,
    ]
    return "\t".join(columns)


def _surface(token: Token) -> tuple[int, int, str | None]:
    """The words of one fused token (zrobił + em) share their span and mwt."""
    return token["start"], token["end"], token.get("mwt")


def write(blob: Blob, text: str) -> str:
    """The blob as CoNLL-U. text is the source text the blob was built from."""
    lines: list[str] = []
    for sentence in blob["sentences"]:
        lines.append(f"# text = {utf16_slice(text, sentence['start'], sentence['end'])}")
        surfaces = [list(words) for _, words in groupby(sentence["tokens"], key=_surface)]
        first = 1
        for words, following in zip(surfaces, [*surfaces[1:], None], strict=True):
            space_after = following is not None and following[0]["start"] > words[0]["end"]
            misc = EMPTY if space_after or following is None else "SpaceAfter=No"
            if len(words) == 1:
                lines.append(_word_line(first, words[0], misc))
            else:
                last = first + len(words) - 1
                mwt = words[0].get("mwt") or ""
                lines.append("\t".join([f"{first}-{last}", mwt, *[EMPTY] * 7, misc]))
                lines += [_word_line(first + i, word, EMPTY) for i, word in enumerate(words)]
            first += len(words)
        lines.append("")
    return "\n".join(lines) + "\n"


@dataclass
class GoldWord:
    form: str
    lemma: str
    upos: str
    xpos: str
    feats: dict[str, str]
    head: int
    deprel: str
    fused_form: str | None
    """The surface multi-word token this word was split from, if any."""
    part_index: int
    """Position within the fused token (0 for unfused words)."""


@dataclass
class GoldSentence:
    sent_id: str
    text: str
    words: list[GoldWord] = field(default_factory=list[GoldWord])


def parse_feats(raw: str) -> dict[str, str]:
    if raw == "_":
        return {}
    return dict(pair.split("=", 1) for pair in raw.split("|"))


def read(path: Path) -> Iterator[GoldSentence]:
    sentence = GoldSentence("", "")
    fused: tuple[int, int, str] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# sent_id = "):
            sentence.sent_id = line.removeprefix("# sent_id = ")
        elif line.startswith("# text = "):
            sentence.text = line.removeprefix("# text = ")
        elif not line:
            if sentence.words:
                yield sentence
            sentence = GoldSentence("", "")
        elif not line.startswith("#"):
            cols = line.split("\t")
            word_id = cols[0]
            if "-" in word_id:
                first, last = (int(n) for n in word_id.split("-"))
                fused = (first, last, cols[1])
                continue
            if "." in word_id:
                continue
            number = int(word_id)
            in_fused = fused is not None and fused[0] <= number <= fused[1]
            sentence.words.append(
                GoldWord(
                    form=cols[1],
                    lemma=cols[2],
                    upos=cols[3],
                    xpos=cols[4],
                    feats=parse_feats(cols[5]),
                    head=int(cols[6]),
                    deprel=cols[7],
                    fused_form=fused[2] if fused and in_fused else None,
                    part_index=number - fused[0] if fused and in_fused else 0,
                )
            )
    if sentence.words:
        yield sentence
