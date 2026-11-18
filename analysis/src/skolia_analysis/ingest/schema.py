"""Messages and blob layout shared by skolia-api and skolia-ingest."""

import hashlib
from typing import Literal, NotRequired, TypedDict


class IngestJob(TypedDict):
    doc: str
    """Document id: sha256 hex of the UTF-8 text."""
    lang: str


class ReadyAnalysis(TypedDict):
    """The analysis a ready document reads: its blob keys, and the analyser and lexicon that
    made them. A job that succeeds answers with it, and the run puts it in the status."""

    analyzer: str
    lexicon: str
    analysis: str
    """Blob key of the analysis."""
    bundle: str
    """Blob key of the lexicon bundle."""


class JobResult(TypedDict):
    """How a job ended, the answer to POST /jobs: its analysis, or why it failed. The
    ingest Worker's run that asked for it writes the document's status from it."""

    outcome: Literal["ready", "failed"]
    analysis: ReadyAnalysis | None
    error: str | None


Stage = Literal[
    "reading",
    "loading-analysis",
    "analysing",
    "bundling",
    "compressing-analysis",
    "uploading-analysis",
    "compressing-bundle",
    "uploading-bundle",
]


class StageTime(TypedDict):
    stage: Stage
    ms: int


class JobAttempt(TypedDict):
    """One attempt at a job in a container, for the ingest history (ingest/migrations).
    retried: storage failed and the job went back in line, to be attempted again."""

    id: str
    image: str
    acceptedAt: str
    startedAt: str
    finishedAt: str
    outcome: Literal["ready", "failed", "retried"]
    error: str | None
    chars: int | None
    """Null for an attempt that failed before it read the text, as is words."""
    words: int | None
    stages: list[StageTime]
    """The stages it ran, in order, the one it failed in included."""


class JobAnswer(TypedDict):
    """The answer to POST /jobs, once the job has finished: its result, and its attempts,
    which the run that asked for it adds to the ingest history."""

    result: JobResult
    attempts: list[JobAttempt]


type State = Literal["queued", "analysing", "ready", "failed"]


class QueuedStatus(TypedDict):
    state: Literal["queued"]
    updated: str
    artifacts: NotRequired[ReadyAnalysis]
    """The previous analysis stays readable while its replacement is being made."""


class ReadyStatus(TypedDict):
    state: Literal["ready"]
    updated: str
    artifacts: ReadyAnalysis


class FailedStatus(TypedDict):
    state: Literal["failed"]
    updated: str
    error: str
    artifacts: NotRequired[ReadyAnalysis]


type Status = QueuedStatus | ReadyStatus | FailedStatus


class Versions(TypedDict):
    """What ingest currently produces for a language, written when it starts. A ready
    document whose analysis or bundle has another name is out of date, and the API
    queues it again; until the new analysis is ready, the status keeps the old keys and
    the reader shows the old analysis."""

    analyzer: str
    lexicon: str
    analysis: str
    """analysis_name: the blob shape and analyzer, the part of the key that changes."""
    bundle: str
    """bundle_name: the bundle shape, analyzer and lexicon."""


SHORT_HASH = 12

MAX_TEXT_LENGTH = 20_000
"""Longest text ingest analyses, in characters; generated into shared/schema.gen.ts for
the API and reader. (JavaScript counts UTF-16 units, so the API's check is the stricter
one for text outside the BMP, such as emoji.) Kept small because analysis time is what
costs money: at about 46 words a second on an M-series Mac, a text at the limit (about
3,000 words) takes roughly a minute."""


def doc_id(lang: str, text: str) -> str:
    """sha256 hex of the UTF-8 "{lang}\n{text}": the same text in two languages is two
    documents. As docId in shared/keys.ts."""
    return hashlib.sha256(f"{lang}\n{text}".encode()).hexdigest()


def short_hash(value: str) -> str:
    """Version strings contain / : + (pl/0.4+combo-4.0.14:...), so keys use a hash."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:SHORT_HASH]


# Everything about a document sits under one prefix, so it can be inspected or deleted
# in one place:
#   doc/{doc}/text.txt
#   doc/{doc}/status.json
#   doc/{doc}/analysis/{analysis_name}.json.br   s{schema}-a{analyzer}
#   doc/{doc}/bundle/{bundle_name}.json.br       b{bundle schema}-v{bundler}-a{analyzer}-l{lexicon}
# and, per language:
#   versions/{lang}.json


def doc_prefix(doc: str) -> str:
    return f"doc/{doc}/"


def text_key(doc: str) -> str:
    return f"{doc_prefix(doc)}text.txt"


def status_key(doc: str) -> str:
    return f"{doc_prefix(doc)}status.json"


def analysis_name(schema: int, analyzer: str) -> str:
    return f"s{schema}-a{short_hash(analyzer)}"


def bundle_name(bundle_schema: int, bundler: str, analyzer: str, lexicon: str) -> str:
    return f"b{bundle_schema}-v{bundler}-a{short_hash(analyzer)}-l{short_hash(lexicon)}"


def analysis_key(doc: str, name: str) -> str:
    return f"{doc_prefix(doc)}analysis/{name}.json.br"


def bundle_key(doc: str, name: str) -> str:
    return f"{doc_prefix(doc)}bundle/{name}.json.br"


def versions_key(lang: str) -> str:
    return f"versions/{lang}.json"
