"""Citation validation and the reject-and-retry loop, with a scripted fake LLM."""

from __future__ import annotations

import json

import numpy as np
import pytest

from faultline import explain as X
from faultline.llm import ChatResult, extract_json

EXCERPTS = [
    {
        "id": "doe-p033-c1", "doc": "doe-sourcebook", "page": 33, "printed_page": 28,
        "text": "Leaks can be a significant source of wasted energy in an industrial compressed air "
                "system, sometimes wasting 20 to 30 percent of a compressor’s output. Leaks cause "
                "a drop in system pressure, which can make air tools function less efficiently.",
    },
    {
        "id": "apu-s02-c1", "doc": "apu-description", "page": 2, "printed_page": None,
        "text": "How the unit cycles. The compressor does not run continuously. A pressure switch "
                "signal (MPG) starts the compressor under load when the pressure in the unit falls below 8.2 bar.",
    },
]

GOOD = {
    "summary": "The compressor has stopped cycling and is running under load without a break.",
    "likely_causes": [
        {"cause": "Air leak downstream of the compressor",
         "evidence": "under load 100% of the last 30 minutes; normal is 7%", "confidence": "medium"}
    ],
    "recommended_actions": [
        {"action": "Walk the pneumatic circuit and listen for leaks", "why": "locates the loss", "urgency": "now"},
        {"action": "Check the dryer drain valve", "why": "a stuck drain vents air", "urgency": "this_shift"},
    ],
    "citations": [
        {"doc": "doe-sourcebook", "page": 33,
         "quote": "Leaks cause a drop in system pressure, which can make air tools function less efficiently"},
        {"doc": "apu-description", "page": 2,
         "quote": "starts the compressor under load when the pressure in the unit falls below 8.2 bar"},
    ],
}


def with_citations(*citations) -> dict:
    return {**GOOD, "citations": list(citations)}


def test_valid_explanation_passes():
    assert X.explanation_problems(GOOD, EXCERPTS) == []


def test_quote_matching_ignores_case_whitespace_and_curly_quotes():
    cite = {"doc": "doe-sourcebook", "page": 33,
            "quote": "  sometimes wasting 20 to 30 percent of a\n compressor's OUTPUT. "}
    assert X.citation_problems([cite], EXCERPTS) == []


def test_quote_matching_tolerates_words_broken_by_the_pdf():
    excerpt = [{**EXCERPTS[0], "text": "A typical plant will likely have a leak rate equal to 20 percent of total com- pressed air production capacity."}]
    cite = {"doc": "doe-sourcebook", "page": 33,
            "quote": "a leak rate equal to 20 percent of total compressed air production capacity"}
    assert X.citation_problems([cite], excerpt) == []


def test_fabricated_quote_is_rejected():
    cite = {"doc": "doe-sourcebook", "page": 33,
            "quote": "Leaks always indicate a failed discharge valve that must be replaced immediately"}
    problems = X.citation_problems([cite], EXCERPTS)
    assert len(problems) == 1 and "does not appear word for word" in problems[0]


def test_right_quote_wrong_page_is_rejected():
    cite = {**GOOD["citations"][0], "page": 34}
    problems = X.citation_problems([cite], EXCERPTS)
    assert any("not one of the excerpts" in p for p in problems)


def test_paraphrase_and_short_quotes_are_rejected():
    short = {"doc": "doe-sourcebook", "page": 33, "quote": "Leaks cause a drop"}
    assert any("too short" in p for p in X.citation_problems([short], EXCERPTS))


def test_at_least_one_manual_citation_is_required():
    problems = X.explanation_problems(with_citations(GOOD["citations"][1], GOOD["citations"][1]), EXCERPTS)
    assert problems == ["at least one citation must come from doc doe-sourcebook"]


def test_schema_violations_are_reported():
    bad = {**GOOD, "likely_causes": [{"cause": "x", "evidence": "y", "confidence": "certain"}]}
    assert X.explanation_problems(bad, EXCERPTS)[0].startswith("schema:")
    assert X.explanation_problems({k: v for k, v in GOOD.items() if k != "citations"}, EXCERPTS)[0].startswith("schema:")


def test_chat_citations_must_point_at_retrieved_pages():
    ok = "Check the drain valve first [doe-sourcebook p.33]. The unit starts loading below 8.2 bar [apu-description p.2]."
    assert X.chat_problems(ok, EXCERPTS) == []
    bad = "Replace the separator [doe-sourcebook p.71]."
    assert "[doe-sourcebook p.71]" in X.chat_problems(bad, EXCERPTS)[0]


def test_extract_json_tolerates_fences_and_prose():
    assert extract_json('{"a": 1}') == {"a": 1}
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('Here you go: {"a": {"b": 2}} done') == {"a": {"b": 2}}
    with pytest.raises(json.JSONDecodeError):
        extract_json("no json here")


class FakeLLM:
    """Returns scripted replies in order and records what it was sent."""

    model = "fake"

    def __init__(self, replies: list[str]):
        self.replies = list(replies)
        self.requests: list[list[dict]] = []

    def chat(self, messages, **kwargs) -> ChatResult:
        self.requests.append(messages)
        return ChatResult(content=self.replies.pop(0), reasoning=None, prompt_tokens=100,
                          completion_tokens=50, latency_s=1.0, model=self.model)


def run(replies: list[str]):
    llm = FakeLLM(replies)
    calls: list[dict] = []
    parsed, attempts = X.generate_validated(
        llm, [{"role": "user", "content": "explain"}], purpose="explain", alarm_id="A001",
        problems_of=lambda p: X.explanation_problems(p, EXCERPTS),
        json_schema=X.schema("explanation"), schema_name="x", calls=calls,
    )
    return llm, parsed, attempts, calls


def test_bad_citation_is_rejected_then_retry_succeeds():
    fabricated = with_citations(
        {"doc": "doe-sourcebook", "page": 33, "quote": "A leak this size will destroy the compressor within a week of running"},
        GOOD["citations"][1],
    )
    llm, parsed, attempts, calls = run([json.dumps(fabricated), json.dumps(GOOD)])
    assert attempts == 2 and parsed == GOOD
    assert [c["attempt"] for c in calls] == [1, 2]
    feedback = llm.requests[1][-1]["content"]
    assert "rejected" in feedback and "does not appear word for word" in feedback


def test_invalid_json_is_retried():
    _, parsed, attempts, _ = run(["I think it is a leak.", json.dumps(GOOD)])
    assert attempts == 2 and parsed == GOOD


def test_gives_up_after_max_attempts():
    fabricated = json.dumps(with_citations({"doc": "doe-sourcebook", "page": 99, "quote": "x " * 10}))
    with pytest.raises(RuntimeError, match="still invalid"):
        run([fabricated] * X.MAX_ATTEMPTS)


class FakeEmbedder:
    def embed_queries(self, queries):
        v = np.zeros((len(queries), 3), dtype=np.float32)
        v[:, 0] = 1.0
        return v


def test_retriever_ranks_manual_chunks_and_always_adds_unit_description():
    chunks = [
        {"id": "doe-p010-c1", "doc": "doe-sourcebook", "page": 10, "printed_page": 5, "text": "a"},
        {"id": "doe-p033-c1", "doc": "doe-sourcebook", "page": 33, "printed_page": 28, "text": "b"},
        {"id": "apu-s02-c1", "doc": "apu-description", "page": 2, "printed_page": None, "text": "c"},
    ]
    vectors = np.array([[0.1, 0.9, 0], [0.9, 0.1, 0], [1, 0, 0]], dtype=np.float32)
    retriever = X.Retriever(FakeEmbedder(), chunks, vectors)
    found = retriever.excerpts_for(["leak"], k=1)
    assert [c["id"] for c in found] == ["doe-p033-c1", "apu-s02-c1"]
    assert found[0]["similarity"] == pytest.approx(0.9)
