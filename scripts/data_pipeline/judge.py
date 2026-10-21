"""Typed judgment over (work, capability) pairs, with two interchangeable backends.

Why this exists: `requires` edges cannot be produced by matching words. Searching
18,838 O*NET task texts for "software" returns 999 hits across 362 occupations,
but every one of the 14 hits under oaw:occupation:11-9032.00 (education
administrators) is a false positive - there "program" means a course of study and
"code" means a section of regulation. The edge is a judgment, so it needs a judge,
a rubric, and a recorded provenance for every answer.

Both backends answer the same question and write the same row shape, so their
disagreement is measurable rather than a matter of opinion. Nothing here writes a
reviewed edge: every result lands as ai_proposed + candidate.
"""
from __future__ import annotations

import http.client
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .pipeline import canonical, digest

ROOT = Path(__file__).resolve().parents[2]

METHOD_VERSION = "judge-requires-1"
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
TYPESAFE_MODEL = "jev-latest"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"

# The instruction both backends share. It names the failure mode explicitly
# because that failure mode is measured, not hypothetical.
INSTRUCTIONS = (
    "You are deciding whether completing a unit of work WITHOUT A HUMAN DOING IT "
    "would require a specific ability.\n"
    "The test is practical, not logical: would a system actually need this ability "
    "to do this work as described? You are not being asked whether the work is "
    "strictly impossible without it in some theoretical sense.\n"
    "If the ability IS what this work consists of, the answer is plainly true. "
    "An ability that names the work is not a coincidence of wording, and treating "
    "a near-identical match as suspicious is its own error: 'teach a class' does "
    "require instructional delivery, and saying otherwise records a match as a "
    "false positive when it is the clearest true positive there is.\n"
    "What is NOT evidence is words shared with no requirement behind them. A task "
    "that mentions 'program' may mean a course of study; a task that mentions "
    "'code' may mean a section of regulation. Ask what the work demands, then see "
    "whether this ability is among those demands.\n"
    "Answer false when the work can be done without this ability, or when the "
    "ability is merely adjacent to the subject matter rather than part of the job."
)

CENTRALITY_LEVELS = [
    "The ability is irrelevant to this work.",
    "The ability helps at the margins; the work is mostly something else.",
    "The ability covers a real part of the work but not its core.",
    "The ability covers the core of the work, alongside other requirements.",
    "This work essentially is an exercise of this ability.",
]


UNDECIDED_BAND = 0.05


def _undecided(value: float) -> bool:
    """Symmetric test for the undecided midpoint.

    Plain `abs(v - 0.5) < 0.05` is not symmetric in binary floating point: 0.45
    gives 0.04999999999999999 and 0.55 gives 0.050000000000000044, so mirrored
    readings resolved differently at the band edge. Rounding the distance past
    the representation error makes the two sides agree.
    """
    return round(abs(value - 0.5), 9) <= UNDECIDED_BAND


class JudgeError(RuntimeError):
    """A judge call failed in a way the caller may retry or record."""


@dataclass
class Item:
    """One (work, capability) pair awaiting a decision."""
    work_id: str
    work_text: str
    capability_id: str
    capability_label: str
    capability_definition: str
    capability_criteria: str = ""


@dataclass
class Judgment:
    work_id: str
    capability_id: str
    requires: bool | None
    confidence: float | None
    centrality: float | None
    rationale: str
    unresolved_reason: str | None = None
    raw: dict = field(default_factory=dict)


def load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def _post(url: str, payload: dict, api_key: str, timeout: int) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        raise JudgeError(f"HTTP {error.code}: {detail}") from None
    # http.client.HTTPException is not an OSError, so a truncated response
    # (IncompleteRead) escaped every clause here and killed a sweep 1,800 work
    # nodes in. Everything this call can raise has to become a JudgeError, or
    # the retry that exists for exactly this case never gets to run.
    except (urllib.error.URLError, http.client.HTTPException,
            TimeoutError, OSError) as error:
        raise JudgeError(f"request failed: {type(error).__name__}: {error}") from None
    except ValueError:
        raise JudgeError("response was not JSON") from None
    if isinstance(body, dict) and body.get("error"):
        raise JudgeError(str(body["error"])[:400])
    return body


def _capability_state(item: Item) -> dict:
    return {
        "work": item.work_text,
        "ability": {
            "name": item.capability_label,
            "definition": item.capability_definition,
            **({"what_counts_as_evidence": item.capability_criteria} if item.capability_criteria else {}),
        },
    }


def _centrality_rationale(value: float, centrality: float | None, score: dict) -> str:
    """Provenance text for one decision; kept balanced because it is stored."""
    text = f"jev noul={value:.3f}"
    if centrality is None:
        return text
    legend = (score.get("legend") or {}).get(str(round(centrality)), "")
    text += f", centrality={float(centrality):.2f}"
    return f"{text} ({legend})" if legend else text


class TypeSafeJudge:
    """Typed decisions from TypeSafe Jev.

    One request per unit of work, one question per capability: the questions run
    in isolation against the same state, so a task is described once and every
    capability is judged against that one description.
    """

    name = "typesafe"
    model = TYPESAFE_MODEL

    def __init__(self, api_key: str | None = None, timeout: int = 60):
        load_env()
        self.api_key = api_key or os.environ.get("TYPESAFE_API_KEY", "")
        if not self.api_key:
            raise JudgeError("TypeSafe is not configured. Set TYPESAFE_API_KEY in .env")
        self.timeout = timeout

    @staticmethod
    def questions(items: list[Item]) -> dict:
        questions = {}
        for index, item in enumerate(items):
            ability = {
                "name": item.capability_label,
                "definition": item.capability_definition,
                **({"what_counts_as_evidence": item.capability_criteria} if item.capability_criteria else {}),
            }
            questions[f"requires_{index}"] = {
                "type": "noul",
                "instructions": {"question": INSTRUCTIONS, "ability": ability},
                "criteria": {
                    "true": "Without this ability the work cannot be completed autonomously.",
                    "false": "The work can be completed autonomously without this ability, "
                             "or the ability only shares vocabulary with the work.",
                },
            }
            questions[f"centrality_{index}"] = {
                "type": "score",
                "instructions": {"question": "How central is this ability to this work?", "ability": ability},
                "criteria": list(CENTRALITY_LEVELS),
            }
        return questions

    def judge(self, work_text: str, items: list[Item]) -> list[Judgment]:
        """All items must share one work_id; that shared work is the state."""
        payload = {
            "state": {"work": work_text},
            "model": self.model,
            "questions": self.questions(items),
        }
        body = _post(TYPESAFE_URL, payload, self.api_key, self.timeout)
        answers = body.get("answers") or {}
        results = []
        for index, item in enumerate(items):
            noul = answers.get(f"requires_{index}") or {}
            score = answers.get(f"centrality_{index}") or {}
            value = noul.get("noul")
            centrality = score.get("score")
            # Both readings are whatever the service returned. A non-numeric one
            # must become "no reading", not a ValueError: ValueError escapes
            # judge_with_retry, which only catches JudgeError, and one odd answer
            # would kill the whole batch.
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                value = None
            if not isinstance(centrality, (int, float)) or isinstance(centrality, bool):
                centrality = None
            if value is None:
                results.append(Judgment(
                    item.work_id, item.capability_id, None, None, None,
                    rationale="judge returned no value",
                    unresolved_reason="typesafe returned no noul value for this pair",
                    raw={"noul": noul, "score": score}))
                continue
            # The noul value is itself the certainty, so 0.5 means undecided.
            undecided = _undecided(value)
            results.append(Judgment(
                work_id=item.work_id,
                capability_id=item.capability_id,
                requires=None if undecided else bool(value > 0.5),
                confidence=round(float(value if value > 0.5 else 1 - value), 3),
                centrality=None if centrality is None else float(centrality),
                rationale=_centrality_rationale(value, centrality, score),
                unresolved_reason="noul is at the undecided midpoint" if undecided else None,
                raw={"noul": noul, "score": score},
            ))
        return results

    def prompt_sha256(self) -> str:
        return digest({"instructions": INSTRUCTIONS, "levels": CENTRALITY_LEVELS, "model": self.model})


DEEPSEEK_SYSTEM = (
    INSTRUCTIONS
    + "\n\nYou will be given one unit of work and several abilities. For each ability "
    "return an object with: index (int), requires (true, false, or null when you "
    "genuinely cannot decide), confidence (0..1), centrality (integer 0-4 using the "
    "given scale), rationale (one sentence, citing the words in the work text that "
    "decided it), and unresolved_reason (a short string, required when requires is null, "
    "otherwise null).\n"
    "There is no 'probably' bucket: if you cannot decide, return null with a reason so "
    "the gap can be counted and fixed.\n"
    "Centrality scale: "
    + "; ".join(f"{i}={text}" for i, text in enumerate(CENTRALITY_LEVELS))
    + "\nReturn ONLY a JSON object of the form {\"judgments\": [...]}"
)


class DeepSeekJudge:
    """The same decision from a general chat model, for comparison."""

    name = "deepseek"

    def __init__(self, api_key: str | None = None, timeout: int = 120):
        load_env()
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
        if not self.api_key:
            raise JudgeError("DeepSeek is not configured. Set DEEPSEEK_API_KEY in .env")
        self.model = os.environ.get("DEEPSEEK_MODEL", DEEPSEEK_MODEL)
        self.base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
        self.timeout = timeout

    def judge(self, work_text: str, items: list[Item]) -> list[Judgment]:
        abilities = [
            {
                "index": index,
                "name": item.capability_label,
                "definition": item.capability_definition,
                **({"what_counts_as_evidence": item.capability_criteria} if item.capability_criteria else {}),
            }
            for index, item in enumerate(items)
        ]
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": DEEPSEEK_SYSTEM},
                {"role": "user", "content": json.dumps(
                    {"work": work_text, "abilities": abilities}, ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
            "stream": False,
        }
        body = _post(f"{self.base_url}/chat/completions", payload, self.api_key, self.timeout)
        choices = body.get("choices") or []
        if not choices:
            raise JudgeError("no choices in response")
        try:
            parsed = json.loads(choices[0]["message"]["content"])
        except (KeyError, TypeError, ValueError):
            raise JudgeError("model content was not JSON") from None
        by_index = {}
        for entry in parsed.get("judgments", []) if isinstance(parsed, dict) else []:
            if isinstance(entry, dict) and isinstance(entry.get("index"), int):
                by_index[entry["index"]] = entry
        results = []
        for index, item in enumerate(items):
            entry = by_index.get(index)
            if entry is None:
                results.append(Judgment(
                    item.work_id, item.capability_id, None, None, None,
                    rationale="judge returned nothing for this pair",
                    unresolved_reason="deepseek omitted this ability from its answer"))
                continue
            requires = entry.get("requires")
            requires = requires if isinstance(requires, bool) else None
            confidence = entry.get("confidence")
            confidence = round(float(confidence), 3) if isinstance(confidence, (int, float)) else None
            centrality = entry.get("centrality")
            centrality = float(centrality) if isinstance(centrality, (int, float)) else None
            reason = entry.get("unresolved_reason")
            results.append(Judgment(
                work_id=item.work_id,
                capability_id=item.capability_id,
                requires=requires,
                confidence=None if confidence is None else max(0.0, min(1.0, confidence)),
                centrality=None if centrality is None else max(0.0, min(4.0, centrality)),
                rationale=str(entry.get("rationale") or "")[:600] or "no rationale given",
                unresolved_reason=(str(reason)[:300] if requires is None and reason
                                   else ("model returned a non-boolean decision" if requires is None else None)),
                raw=entry,
            ))
        return results

    def prompt_sha256(self) -> str:
        return digest({"system": DEEPSEEK_SYSTEM, "model": self.model})


JUDGES = {"typesafe": TypeSafeJudge, "deepseek": DeepSeekJudge}


def build_judge(name: str):
    if name not in JUDGES:
        raise JudgeError(f"Unknown judge {name}; choose from {', '.join(sorted(JUDGES))}")
    return JUDGES[name]()


def _object_id(item) -> str:
    """What the item is judged against, whatever kind of item it is.

    Items name their object differently - a requires item has a capability, a
    blocked_by item has a gate - and the retry fallback has to build a Judgment
    for either. Reading the attribute blindly crashed a sweep 2,200 work nodes in,
    on the one path that only runs when the service is already failing.
    """
    for name in ("capability_id", "gate_id"):
        value = getattr(item, name, None)
        if value:
            return value
    raise AttributeError(f"{type(item).__name__} names no object to judge against")


def judge_with_retry(judge, work_text: str, items, attempts: int = 4) -> list[Judgment]:
    """Retry, then give up on this item and say so.

    The backoff is deliberately long at the tail: a connection-level outage
    lasts minutes, and three attempts six seconds apart burn through it for
    every request in flight. That produced 604,486 rows saying "could not
    decide" for requests that never reached the service.
    """
    last = None
    for attempt in range(attempts):
        try:
            return judge.judge(work_text, items)
        except JudgeError as error:
            last = error
            if attempt < attempts - 1:
                time.sleep(min(30, 3 * (2 ** attempt)))
    return [
        Judgment(item.work_id, _object_id(item), None, None, None,
                 rationale=f"judge failed: {last}",
                 unresolved_reason=f"{judge.name} failed after {attempts} attempts: {last}")
        for item in items
    ]


# ---------------------------------------------------------------------------
# demonstrates: what one event says about one capability, and how strongly.
# ---------------------------------------------------------------------------

DEMONSTRATES_INSTRUCTIONS = (
    "You are deciding what a published update tells us about a specific ability.\n"
    "TWO different things count as evidence, and both count fully:\n"
    "  (a) A measurement: a score, an error rate, a ranking on a named test.\n"
    "  (b) Real use: a named organisation actually running this in its operations. "
    "This needs no number at all. That someone depends on it for real work is itself "
    "the claim, and it says more about the ability than any benchmark does.\n"
    "Do not require (a) before accepting (b). An update reporting that a named company "
    "uses this in production IS evidence about the ability, even with no metrics.\n"
    "A documented failure or outage is also evidence - evidence against.\n"
    "What does NOT count: an announcement that a product exists, a availability or "
    "pricing change, a partnership with no described use.\n"
    "Judge only what this update actually reports. Do not use what you know about the "
    "company from elsewhere."
)

TIER_CRITERIA = {
    "T1": "A result produced by a party with no affiliation to the publisher (an independent "
          "benchmark, an outside evaluator), or an adopting organisation confirming its own "
          "production use.",
    "T2": "Two or more mutually independent sources describe the same fact, or an outside "
          "institution issues a rating that rests on its own judgement rather than a "
          "reproducible test.",
    "T3": "The publisher's own statement about ITS OWN PRODUCT - documentation or "
          "self-reported numbers from the vendor. A publisher describing its own USE "
          "of someone else's product is T1, not this.",
    "T4": "A marketing claim or an anonymous account that cannot be traced to a responsible "
          "party or re-checked.",
}


def autonomy_levels() -> list[str]:
    """The autonomy rubric, read from the schema rather than restated here."""
    from .ontology_schema import load_schema
    terms = load_schema()["vocabularies"]["autonomy_stage"]["terms"]
    return [
        f"{terms[str(i)]['label']['zh-CN']}: {terms[str(i)]['definition']['zh-CN']}"
        for i in range(5)
    ]


AUTONOMY_QUESTION = (
    "In the use this update describes, how much of the work does the ability do "
    "on its own, and how much does a person still do?\n"
    "Judge only the working arrangement described here. Being deployed in "
    "production says nothing by itself: a person reviewing or reworking every "
    "output is supervised use even when it runs a real business every day."
)


@dataclass
class EvidenceItem:
    event_id: str
    event_text: dict
    capability_id: str
    capability_label: str
    capability_definition: str
    capability_criteria: str = ""


@dataclass
class EvidenceJudgment:
    event_id: str
    capability_id: str
    demonstrates: bool | None
    evidence_tier: str | None
    evidence_sign: str
    confidence: float | None
    rationale: str
    unresolved_reason: str | None = None
    observed_stage: float | None = None
    observed_stage_rationale: str | None = None


def _tier_questions() -> dict:
    return {
        "tier": {
            "type": "choice",
            "instructions": "Who produced the claim in this update, and how checkable is it?",
            "criteria": dict(TIER_CRITERIA),
        }
    }


class _DemonstratesMixin:
    @staticmethod
    def evidence_questions(items: list[EvidenceItem]) -> dict:
        questions = _tier_questions()
        for index, item in enumerate(items):
            ability = {
                "name": item.capability_label,
                "definition": item.capability_definition,
                **({"what_counts_as_evidence": item.capability_criteria} if item.capability_criteria else {}),
            }
            questions[f"demonstrates_{index}"] = {
                "type": "noul",
                "instructions": {"question": DEMONSTRATES_INSTRUCTIONS, "ability": ability},
                "criteria": {
                    "true": "This update reports something verifiable about how well this ability works.",
                    "false": "This update says nothing checkable about this ability, or concerns a "
                             "different ability entirely.",
                },
            }
            questions[f"autonomy_{index}"] = {
                "type": "score",
                "instructions": {"question": AUTONOMY_QUESTION, "ability": ability},
                "criteria": autonomy_levels(),
            }
            questions[f"positive_{index}"] = {
                "type": "noul",
                "instructions": {"question": "Does this update show the ability working, or failing?",
                                 "ability": ability},
                "criteria": {
                    "true": "It shows the ability working, improving, or in successful use.",
                    "false": "It shows the ability failing, degraded, withdrawn or falling short.",
                },
            }
        return questions


class TypeSafeEvidenceJudge(TypeSafeJudge, _DemonstratesMixin):
    def judge_evidence(self, event_text: dict, items: list[EvidenceItem]) -> list[EvidenceJudgment]:
        payload = {"state": event_text, "model": self.model,
                   "questions": self.evidence_questions(items)}
        body = _post(TYPESAFE_URL, payload, self.api_key, self.timeout)
        answers = body.get("answers") or {}
        tier_answer = answers.get("tier") or {}
        tier = tier_answer.get("choice")
        tier = tier if tier in TIER_CRITERIA else None
        results = []
        for index, item in enumerate(items):
            shown = (answers.get(f"demonstrates_{index}") or {}).get("noul")
            positive = (answers.get(f"positive_{index}") or {}).get("noul")
            autonomy = (answers.get(f"autonomy_{index}") or {}).get("score")
            for name in ("shown", "positive", "autonomy"):
                reading = locals()[name]
                if not isinstance(reading, (int, float)) or isinstance(reading, bool):
                    if name == "shown":
                        shown = None
                    elif name == "positive":
                        positive = None
                    else:
                        autonomy = None
            if shown is None:
                results.append(EvidenceJudgment(
                    item.event_id, item.capability_id, None, None, "positive", None,
                    "judge returned no value",
                    "typesafe returned no demonstrates value for this pair"))
                continue
            undecided = _undecided(shown)
            # A missing or undecided direction reading is not permission to call
            # the evidence favourable. Unreadable direction makes the whole row
            # unresolved, the same way an unreadable autonomy reading caps a stage.
            if positive is None or _undecided(positive):
                sign, sign_unreadable = "positive", True
            else:
                sign, sign_unreadable = ("negative" if positive < 0.5 else "positive"), False
            # Half steps, because the rubric allows them and rounding to whole
            # stages would quietly promote a 2.4 to a 3.
            stage = (round(float(autonomy) * 2) / 2) if isinstance(autonomy, (int, float)) else None
            results.append(EvidenceJudgment(
                event_id=item.event_id,
                capability_id=item.capability_id,
                demonstrates=None if (undecided or (shown > 0.5 and sign_unreadable))
                             else bool(shown > 0.5),
                evidence_tier=tier,
                evidence_sign=sign,
                confidence=round(float(shown if shown > 0.5 else 1 - shown), 3),
                rationale=f"jev demonstrates={shown:.3f}, sign={sign}, tier={tier or 'undetermined'}",
                unresolved_reason=(
                    "demonstrates is at the undecided midpoint" if undecided
                    else "whether the evidence is favourable or unfavourable could not be read"
                    if (shown > 0.5 and sign_unreadable)
                    else "tier could not be determined"
                    if (shown > 0.5 and tier is None) else None),
                observed_stage=stage,
                observed_stage_rationale=(
                    f"described use scored {float(autonomy):.2f} on the autonomy rubric"
                    if autonomy is not None else None),
            ))
        return results

    def evidence_prompt_sha256(self) -> str:
        return digest({"instructions": DEMONSTRATES_INSTRUCTIONS, "tiers": TIER_CRITERIA,
                       "autonomy": AUTONOMY_QUESTION, "levels": autonomy_levels(),
                       "model": self.model})


# ---------------------------------------------------------------------------
# blocked_by: a condition that stops the work even when the abilities are there.
# ---------------------------------------------------------------------------

GATE_INSTRUCTIONS = (
    "You are deciding whether a condition BLOCKS a unit of work from being "
    "completed without a person, for reasons that have nothing to do with how "
    "good the software is.\n"
    "The test is: if an AI system were perfect at every ability this work needs, "
    "would this condition still stop it? Answer true only then.\n"
    "A condition that better models would overcome is not a gate - it is a "
    "capability that is not there yet, and calling it a gate would record a "
    "solvable problem as a permanent one.\n"
    "A gate lifts only when a law, an institution, an accountability rule, or the "
    "physical world changes.\n"
    "The condition must govern THE OUTPUT OF THIS PARTICULAR WORK, not the setting "
    "it happens in. A rule that a clinician signs medical records blocks producing "
    "a medical record; it does not block sorting the mail in a clinic. Sharing a "
    "workplace with a gated activity is not being gated."
)


@dataclass
class GateItem:
    work_id: str
    work_text: str
    gate_id: str
    gate_label: str
    gate_definition: str
    gate_type: str = ""


class TypeSafeGateJudge(TypeSafeJudge):
    @staticmethod
    def gate_questions(items: list[GateItem]) -> dict:
        questions = {}
        for index, item in enumerate(items):
            condition = {
                "name": item.gate_label,
                "definition": item.gate_definition,
                **({"kind": item.gate_type} if item.gate_type else {}),
            }
            questions[f"blocked_{index}"] = {
                "type": "noul",
                "instructions": {"question": GATE_INSTRUCTIONS, "condition": condition},
                "criteria": {
                    "true": "Even with perfect software, this condition still stops the "
                            "work from being completed without a person.",
                    "false": "Better software would get past this, or the condition does "
                             "not apply to this work at all.",
                },
            }
        return questions

    def judge(self, work_text: str, items: list[GateItem]) -> list[Judgment]:
        """A gate judge judges gates; the inherited requires questions do not apply."""
        return self.judge_gates(work_text, items)

    def judge_gates(self, work_text: str, items: list[GateItem]) -> list[Judgment]:
        payload = {"state": {"work": work_text}, "model": self.model,
                   "questions": self.gate_questions(items)}
        body = _post(TYPESAFE_URL, payload, self.api_key, self.timeout)
        answers = body.get("answers") or {}
        results = []
        for index, item in enumerate(items):
            value = (answers.get(f"blocked_{index}") or {}).get("noul")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                value = None
            if value is None:
                results.append(Judgment(
                    item.work_id, item.gate_id, None, None, None,
                    rationale="judge returned no value",
                    unresolved_reason="typesafe returned no blocked value for this pair"))
                continue
            undecided = _undecided(value)
            results.append(Judgment(
                work_id=item.work_id,
                capability_id=item.gate_id,
                requires=None if undecided else bool(value > 0.5),
                confidence=round(float(value if value > 0.5 else 1 - value), 3),
                centrality=None,
                rationale=f"jev blocked={value:.3f}",
                unresolved_reason="blocked is at the undecided midpoint" if undecided else None,
            ))
        return results

    def prompt_sha256(self) -> str:
        return self.gate_prompt_sha256()

    def gate_prompt_sha256(self) -> str:
        return digest({"instructions": GATE_INSTRUCTIONS, "model": self.model})


DEEPSEEK_EVIDENCE_SYSTEM = (
    DEMONSTRATES_INSTRUCTIONS
    + "\n\nAn update that simply says nothing about an ability is a FALSE, not an "
    "undecided one. 'Not relevant', 'not mentioned' and 'no content about this' are "
    "all clear answers, and the clear answer is false. Reserve null for a genuine "
    "two-way case: the update touches the ability but you cannot tell whether it "
    "shows it working. Answering null for an irrelevant ability records a decision "
    "you did make as a gap you did not have.\n"
    "\nYou will be given one published update and several abilities.\n"
    "First judge the update as a whole: which tier of evidence is it?\n"
    + "\n".join(f"  {tier}: {text}" for tier, text in TIER_CRITERIA.items())
    + "\n\nThen, for each ability, return an object with: index (int); demonstrates "
    "(true, false, or null when you genuinely cannot decide); confidence (0..1); "
    "sign (\"positive\" when it shows the ability working, \"negative\" when it shows "
    "it failing, null when the update does not make that readable); observed_stage "
    "(a number 0-4 in half steps for how autonomously the ability is used in what "
    "this update describes, or null if the update does not say); rationale (one "
    "sentence); unresolved_reason (required when demonstrates is null).\n"
    "Autonomy scale: {autonomy}\n"
    "Being deployed in production says nothing by itself about autonomy: a person "
    "reviewing or reworking every output is supervised use even when it runs a real "
    "business every day.\n"
    "Return ONLY a JSON object of the form "
    "{\"tier\": \"T1\"|\"T2\"|\"T3\"|\"T4\", \"abilities\": [...]}"
)


class DeepSeekEvidenceJudge(DeepSeekJudge):
    """The same evidence questions as the typed judge, from a general model.

    Exists because the typed judge's credits can run out mid-sweep, and a graph
    that can say what work needs which ability but nothing about how far along
    that ability is only answers half the question.
    """

    def _system(self) -> str:
        return DEEPSEEK_EVIDENCE_SYSTEM.replace(
            "{autonomy}", "; ".join(f"{i}={text}" for i, text in enumerate(autonomy_levels())))

    def judge_evidence(self, event_text: dict, items: list) -> list:
        abilities = [
            {"index": index, "name": item.capability_label,
             "definition": item.capability_definition,
             **({"what_counts_as_evidence": item.capability_criteria}
                if item.capability_criteria else {})}
            for index, item in enumerate(items)
        ]
        body = _post(f"{self.base_url}/chat/completions", {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self._system()},
                {"role": "user", "content": json.dumps(
                    {"update": event_text, "abilities": abilities}, ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
            "stream": False,
        }, self.api_key, self.timeout)
        choices = body.get("choices") or []
        if not choices:
            raise JudgeError("no choices in response")
        try:
            parsed = json.loads(choices[0]["message"]["content"])
        except (KeyError, TypeError, ValueError):
            raise JudgeError("model content was not JSON") from None

        tier = parsed.get("tier")
        tier = tier if tier in TIER_CRITERIA else None
        by_index = {e["index"]: e for e in parsed.get("abilities", [])
                    if isinstance(e, dict) and isinstance(e.get("index"), int)}
        results = []
        for index, item in enumerate(items):
            entry = by_index.get(index)
            if entry is None:
                results.append(EvidenceJudgment(
                    item.event_id, item.capability_id, None, None, "positive", None,
                    "judge returned nothing for this pair",
                    "deepseek omitted this ability from its answer"))
                continue
            shown = entry.get("demonstrates")
            shown = shown if isinstance(shown, bool) else None
            sign_raw = entry.get("sign")
            # A missing direction reading is not permission to call it favourable.
            sign_unreadable = sign_raw not in ("positive", "negative")
            stage = entry.get("observed_stage")
            stage = (round(float(stage) * 2) / 2
                     if isinstance(stage, (int, float)) and not isinstance(stage, bool) else None)
            confidence = entry.get("confidence")
            confidence = (round(max(0.0, min(1.0, float(confidence))), 3)
                          if isinstance(confidence, (int, float)) and not isinstance(confidence, bool)
                          else None)
            reason = entry.get("unresolved_reason")
            results.append(EvidenceJudgment(
                event_id=item.event_id,
                capability_id=item.capability_id,
                demonstrates=None if (shown is None or (shown and sign_unreadable)) else shown,
                evidence_tier=tier,
                evidence_sign="positive" if sign_unreadable else sign_raw,
                confidence=confidence,
                rationale=str(entry.get("rationale") or "")[:600] or "no rationale given",
                # A direction only matters when the update does say something about
                # the ability. Attaching "the direction could not be read" to a
                # decided False says "decided, and here is why it could not be
                # decided" - two claims that contradict each other.
                unresolved_reason=(
                    str(reason)[:300] if shown is None and reason
                    else "model returned a non-boolean decision" if shown is None
                    else "whether the evidence is favourable or unfavourable could not be read"
                    if (shown and sign_unreadable)
                    else "tier could not be determined" if (shown and tier is None) else None),
                observed_stage=stage,
                observed_stage_rationale=(
                    f"described use scored {stage:g} on the autonomy rubric"
                    if stage is not None else None),
            ))
        return results

    def evidence_prompt_sha256(self) -> str:
        return digest({"system": self._system(), "model": self.model})


class DeepSeekGateJudge(DeepSeekJudge):
    """Gate decisions from the general model, for when the typed judge is unavailable."""

    def _system(self) -> str:
        return (
            GATE_INSTRUCTIONS
            + "\n\nYou will be given one unit of work and several blocking conditions. "
            "For each condition return an object with: index (int); blocked (true, "
            "false, or null only when you genuinely cannot decide); confidence (0..1); "
            "rationale (one sentence naming what in the work text decided it); "
            "unresolved_reason (required when blocked is null, otherwise null).\n"
            "A condition that plainly does not apply to this work is a FALSE, not an "
            "undecided one. 'Not relevant' is a clear answer, and the clear answer is "
            "false.\n"
            "Return ONLY a JSON object of the form {\"conditions\": [...]}"
        )

    def judge(self, work_text: str, items: list) -> list[Judgment]:
        conditions = [
            {"index": index, "name": item.gate_label,
             "definition": item.gate_definition,
             **({"kind": item.gate_type} if item.gate_type else {})}
            for index, item in enumerate(items)
        ]
        body = _post(f"{self.base_url}/chat/completions", {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self._system()},
                {"role": "user", "content": json.dumps(
                    {"work": work_text, "conditions": conditions}, ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
            "stream": False,
        }, self.api_key, self.timeout)
        choices = body.get("choices") or []
        if not choices:
            raise JudgeError("no choices in response")
        try:
            parsed = json.loads(choices[0]["message"]["content"])
        except (KeyError, TypeError, ValueError):
            raise JudgeError("model content was not JSON") from None
        by_index = {e["index"]: e for e in parsed.get("conditions", [])
                    if isinstance(e, dict) and isinstance(e.get("index"), int)}
        results = []
        for index, item in enumerate(items):
            entry = by_index.get(index)
            if entry is None:
                results.append(Judgment(
                    item.work_id, item.gate_id, None, None, None,
                    rationale="judge returned nothing for this pair",
                    unresolved_reason="deepseek omitted this condition from its answer"))
                continue
            blocked = entry.get("blocked")
            blocked = blocked if isinstance(blocked, bool) else None
            confidence = entry.get("confidence")
            confidence = (round(max(0.0, min(1.0, float(confidence))), 3)
                          if isinstance(confidence, (int, float)) and not isinstance(confidence, bool)
                          else None)
            reason = entry.get("unresolved_reason")
            results.append(Judgment(
                work_id=item.work_id, capability_id=item.gate_id,
                requires=blocked, confidence=confidence, centrality=None,
                rationale=str(entry.get("rationale") or "")[:600] or "no rationale given",
                unresolved_reason=(str(reason)[:300] if blocked is None and reason
                                   else "model returned a non-boolean decision"
                                   if blocked is None else None)))
        return results

    def prompt_sha256(self) -> str:
        return digest({"system": self._system(), "model": self.model})

    def gate_prompt_sha256(self) -> str:
        return self.prompt_sha256()


GATE_JUDGES = {"typesafe": TypeSafeGateJudge, "deepseek": DeepSeekGateJudge}
