"""Knowledge base for the explainer: the DOE compressed air sourcebook plus a short
description of the air production unit.

    python -m faultline.kb            # download, chunk, write results/kb/chunks.json
    python -m faultline.kb --embed    # also embed with the vLLM embedding server (needs the droplet)

Every chunk keeps its page number so the explainer can cite it. Chunks never
cross a page boundary.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from pathlib import Path

import numpy as np

from faultline.config import DATA_DIR, REPO_ROOT, RESULTS_DIR

KB_DIR = RESULTS_DIR / "kb"
CHUNKS_JSON = KB_DIR / "chunks.json"
SOURCES_JSON = KB_DIR / "sources.json"
EMBEDDINGS_BIN = KB_DIR / "embeddings.f32"
EMBEDDINGS_META = KB_DIR / "embeddings.json"
APU_DOC = REPO_ROOT / "docs" / "apu_description.md"

DOE = {
    "doc": "doe-sourcebook",
    "title": "Improving Compressed Air System Performance: A Sourcebook for Industry (Third Edition)",
    "publisher": "U.S. Department of Energy, Advanced Manufacturing Office, with the Compressed Air Challenge",
    "url": "https://www.energy.gov/sites/prod/files/2016/03/f30/"
    "Improving%20Compressed%20Air%20Sourcebook%20version%203.pdf",
    "file": DATA_DIR / "kb" / "doe_compressed_air_sourcebook.pdf",
}
APU = {
    "doc": "apu-description",
    "title": "The MetroPT-3 air production unit: description and normal operating profile",
    "publisher": "Faultline (written from the MetroPT dataset documentation and pre-failure data)",
    "url": "https://github.com/saahilshah178/faultline_amd/blob/main/docs/apu_description.md",
}

CHUNK_CHARS = 1100
CHUNK_OVERLAP = 150
MIN_CHUNK_CHARS = 200

_HEADER = re.compile(r"IMPROVING COMPRESSED AIR SYSTEM PERFORMANCE: A SOURCEBOOK FOR INDUSTRY\s*(?:\|\s*(\d+))?")
_DOT_LEADERS = re.compile(r"(\.{6,}|…{3,})")


def download_doe() -> Path:
    path: Path = DOE["file"]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        req = urllib.request.Request(DOE["url"], headers={"User-Agent": "Mozilla/5.0 (faultline kb builder)"})
        with urllib.request.urlopen(req) as resp, open(path, "wb") as out:
            out.write(resp.read())
    return path


def clean_page(text: str) -> tuple[str, int | None]:
    """Strip the running header, rejoin wrapped lines, return (text, printed page number)."""
    printed = None
    match = _HEADER.search(text)
    if match and match.group(1):
        printed = int(match.group(1))
    text = _HEADER.sub(" ", text)
    text = text.replace("­", "")
    text = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text)  # words hyphenated across lines
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    # The PDF also breaks words inside a line ("com- pressed"). Keep real suspended
    # hyphens ("low- and high-pressure").
    text = re.sub(r"([a-z])- (?!(?:and|or|to)\b)([a-z])", r"\1\2", text)
    return text.strip(), printed


def split_text(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split on sentence boundaries into pieces of about `size` characters."""
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9•])", text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + 1 + len(sentence) > size:
            chunks.append(current)
            tail = current[-overlap:]
            # Start the overlap at a word boundary.
            current = tail[tail.find(" ") + 1 :] if " " in tail else ""
        current = f"{current} {sentence}".strip()
    if current:
        if chunks and len(current) < MIN_CHUNK_CHARS:
            chunks[-1] = f"{chunks[-1]} {current}"
        else:
            chunks.append(current)
    return chunks


def chunk_doe(path: Path) -> list[dict]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    chunks = []
    for page_no, page in enumerate(reader.pages, start=1):
        raw = page.extract_text() or ""
        # Contents and figure lists are dot-leader tables, useless for retrieval.
        if len(_DOT_LEADERS.findall(raw)) >= 5:
            continue
        text, printed = clean_page(raw)
        if len(text) < MIN_CHUNK_CHARS:
            continue
        for i, piece in enumerate(split_text(text), start=1):
            chunks.append(
                {
                    "id": f"doe-p{page_no:03d}-c{i}",
                    "doc": DOE["doc"],
                    "page": page_no,
                    "printed_page": printed,
                    "text": piece,
                }
            )
    return chunks


def chunk_apu(path: Path = APU_DOC) -> list[dict]:
    """One chunk per numbered section of the unit description; the section is its 'page'."""
    text = path.read_text()
    sections = re.split(r"^## (\d+)\. (.+)$", text, flags=re.MULTILINE)
    chunks = []
    for number, title, body in zip(sections[1::3], sections[2::3], sections[3::3]):
        body = re.sub(r"\s*\n\s*", " ", body).strip()
        for i, piece in enumerate(split_text(f"{title}. {body}"), start=1):
            chunks.append(
                {
                    "id": f"apu-s{int(number):02d}-c{i}",
                    "doc": APU["doc"],
                    "page": int(number),
                    "printed_page": None,
                    "text": piece,
                }
            )
    return chunks


def build_chunks() -> list[dict]:
    chunks = chunk_doe(download_doe()) + chunk_apu()
    KB_DIR.mkdir(parents=True, exist_ok=True)
    CHUNKS_JSON.write_text(json.dumps(chunks, indent=1, ensure_ascii=False) + "\n")
    sources = [
        {k: v for k, v in DOE.items() if k != "file"} | {"page_label": "PDF page"},
        APU | {"page_label": "section"},
    ]
    for src in sources:
        pages = sorted({c["page"] for c in chunks if c["doc"] == src["doc"]})
        src["chunks"] = sum(c["doc"] == src["doc"] for c in chunks)
        src["pages_indexed"] = len(pages)
    SOURCES_JSON.write_text(json.dumps(sources, indent=2) + "\n")
    return chunks


def load_chunks() -> list[dict]:
    return json.loads(CHUNKS_JSON.read_text())


def load_embeddings() -> np.ndarray:
    meta = json.loads(EMBEDDINGS_META.read_text())
    vectors = np.fromfile(EMBEDDINGS_BIN, dtype="<f4").reshape(meta["count"], meta["dim"])
    return vectors


def embed_chunks(chunks: list[dict]) -> np.ndarray:
    """Embed every chunk with the embedding server on the MI300X and store the vectors."""
    from faultline.llm import EmbedClient

    client = EmbedClient()
    vectors = client.embed_documents([c["text"] for c in chunks])
    vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors.astype("<f4").tofile(EMBEDDINGS_BIN)
    EMBEDDINGS_META.write_text(
        json.dumps(
            {
                "model": client.model,
                "count": int(vectors.shape[0]),
                "dim": int(vectors.shape[1]),
                "normalized": True,
                "dtype": "float32-le",
                "chunk_ids": [c["id"] for c in chunks],
            },
            indent=1,
        )
        + "\n"
    )
    return vectors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--embed", action="store_true", help="embed chunks with the vLLM embedding server")
    args = parser.parse_args(argv)

    chunks = build_chunks()
    by_doc: dict[str, int] = {}
    for c in chunks:
        by_doc[c["doc"]] = by_doc.get(c["doc"], 0) + 1
    print(f"{len(chunks)} chunks: {by_doc}")
    print(f"wrote {CHUNKS_JSON.relative_to(REPO_ROOT)} and {SOURCES_JSON.relative_to(REPO_ROOT)}")
    if args.embed:
        vectors = embed_chunks(chunks)
        print(f"embedded {vectors.shape[0]} chunks, dim {vectors.shape[1]} -> {EMBEDDINGS_BIN.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
