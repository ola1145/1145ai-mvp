"""
Naturalness evals for the voice path (issue E4).

Everything here is something a caller hears, or a setting that decides when they hear it. The voice scenarios are
run through a Python mirror of @1145/conversation-style (offline, always) and through the real TypeScript checker
whenever the repo's node_modules are installed, so the CI gate and these tests can't drift apart silently.
"""
from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import random
import re
import subprocess
from pathlib import Path

import pytest

from frontdesk.fillers import ACKS, FILLERS, FILLERS_BY_KIND, pick_ack, pick_filler
from frontdesk.prompts import GUARDRAILS, VOICE_STYLE, build_instructions
from frontdesk.voice_config import (
    AB_CALL_SCRIPTS,
    AB_STABILITY,
    DEFAULT_TUNING,
    TUNING_PROVENANCE,
    TURN_TAKING_FIELDS,
    Pronunciation,
    ab_trials,
    alias_transform,
    elevenlabs_alias_rules,
    pronunciation_dictionary_request,
    pronunciation_locators,
    provisional_fields,
    session_kwargs,
    trial_tuning,
    tts_text_transforms,
    tts_voice_settings,
    turn_handling,
)

REPO = Path(__file__).resolve().parents[3]
BANNED = ["inconvenience", "your call is important", "please hold", "as an ai", "understand your frustration",
          "just a moment", "one moment please", "thank you for your patience"]


# ── Python mirror of packages/conversation-style (voice channel). Keep in step with src/index.ts. ──────────────────
_PHRASES: list[tuple[str, re.Pattern[str], str]] = [
    ("ai-self-talk", re.compile(r"\bas an ai\b|\b(?:language model|large language model)\b|\bi(?:'m| am) (?:just )?an? (?:ai|bot)\b(?!\s+(?:receptionist|assistant))|\bi don'?t have (?:feelings|emotions)\b", re.I), "error"),
    ("scripted-empathy", re.compile(r"\bi (?:completely |totally )?understand your (?:frustration|concern)s?\b", re.I), "error"),
    ("inconvenience", re.compile(r"\b(?:apologi[sz]e|sorry) for (?:any|the) inconvenience\b", re.I), "error"),
    ("patience", re.compile(r"\bthank you for your patience\b", re.I), "error"),
    ("call-center", re.compile(r"\byour (?:call|business) is (?:very )?important to us\b|\bvalued customer\b|\bplease be advised\b|\bat your earliest convenience\b|\bkindly\b|\bas per\b", re.I), "error"),
    ("email-speak", re.compile(r"\bi hope this (?:message|email) finds you well\b|\bplease do not hesitate\b|\bfeel free to reach out\b", re.I), "error"),
    ("assist-filler", re.compile(r"\b(?:i(?:'d| would) be (?:happy|glad|delighted) to (?:assist|help) you(?: with that)?|how (?:may|can) i assist you(?: today)?)\b", re.I), "warn"),
    ("hollow-opener", re.compile(r"^(?:certainly|absolutely|of course|great question|sure thing)[!.,]", re.I), "warn"),
    ("anything-else", re.compile(r"\bis there anything else (?:i can|that i can) (?:help|assist) you with\b", re.I), "warn"),
    ("hold-script", re.compile(r"\bplease hold\b", re.I), "warn"),
]
_EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")


def _words(s: str) -> list[str]:
    return s.split()


def _opener(s: str) -> str:
    return " ".join(_words(re.sub(r"[^\w\s']", "", s.lower()))[:3])


def style_issues(text: str, previous: list[str] | None = None, *, first: bool = False, person: str | None = None) -> list[tuple[str, str]]:
    """(rule, severity) pairs, voice channel. Mirrors checkReply()."""
    issues: list[tuple[str, str]] = []
    t = text.strip()
    if not t:
        return [("empty", "error")]
    for rule, rx, sev in _PHRASES:
        if rx.search(t):
            issues.append((rule, sev))
    if t.count("?") > 1:
        issues.append(("one-question", "warn"))
    if re.search(r"(^|\n)\s*(?:[-*•]|\d+[.)])\s+", t) or re.search(r"\*\*|__|^#+\s", t, re.M):
        issues.append(("voice-formatting", "error"))
    if re.search(r"https?://|www\.", t, re.I):
        issues.append(("voice-url", "error"))
    if re.search(r"\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?", t):
        issues.append(("voice-iso-date", "error"))
    if _EMOJI.search(t):
        issues.append(("voice-emoji", "error"))
    if re.search(r"\b(?:e\.g\.|i\.e\.|etc\.)", t, re.I):
        issues.append(("voice-abbrev", "warn"))
    if len(_words(t)) > (45 if first else 40):
        issues.append(("voice-length", "error"))
    if any(len(_words(s)) > 25 for s in re.split(r"(?<=[.!?])\s+", t) if s.strip()):
        issues.append(("voice-long-sentence", "warn"))
    prev = previous or []
    last = prev[-1] if prev else None
    if last and _opener(last) and _opener(last) == _opener(t):
        issues.append(("repeated-opener", "warn"))
    if last and last.strip().lower() == t.lower():
        issues.append(("verbatim-repeat", "error"))
    anything_else = _PHRASES[8][1]
    if anything_else.search(t) and any(anything_else.search(p) for p in prev[-3:]):
        issues.append(("anything-else-repeat", "error"))
    if person and last:
        name = re.compile(rf"\b{re.escape(person)}\b", re.I)
        if name.search(t) and name.search(last):
            issues.append(("name-overuse", "warn"))
    return issues


def score(issues: list[tuple[str, str]]) -> int:
    return max(0, 100 - sum(15 if sev == "error" else 5 for _, sev in issues))


def assert_natural(lines: list[str], *, person: str | None = None, conversation: bool = True) -> None:
    """Zero style errors and naturalness >= 85 per turn (the CI gate)."""
    previous: list[str] = []
    for i, line in enumerate(lines):
        issues = style_issues(line, previous if conversation else [], first=conversation and i == 0, person=person)
        errors = [r for r, sev in issues if sev == "error"]
        assert not errors, f"{line!r}: {errors}"
        assert score(issues) >= 85, f"{line!r}: {issues}"
        previous.append(line)


# ── Fillers ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_fillers_never_repeat_the_last_two():
    rng = random.Random(7)
    recent: list[str] = []
    for _ in range(200):
        f = pick_filler(recent, rng)
        assert f not in recent[-2:]
        recent.append(f)


def test_fillers_never_repeat_within_two_uses_across_tools():
    """One call often hits availability, then booking, then info. The caller hears one stream of fillers."""
    rng = random.Random(11)
    recent: list[str] = []
    for i in range(300):
        f = pick_filler(recent, rng, kind=("availability", "booking", "info", "any")[i % 4])
        assert f not in recent[-2:]
        recent.append(f)


def test_back_to_back_fillers_never_start_the_same_way():
    # Old pool: "Let me check that." then "Let me see what's open." sounded like a loop.
    for seed in range(50):
        rng = random.Random(seed)
        recent: list[str] = []
        for i in range(40):
            f = pick_filler(recent, rng, kind=("availability", "booking", "info", "any")[i % 4])
            if recent:
                assert _first_word(f) != _first_word(recent[-1]), (recent[-1], f)
            recent.append(f)


def test_filler_does_not_echo_how_the_agent_just_started():
    rng = random.Random(3)
    for _ in range(100):
        f = pick_filler([], rng, last_agent_turn="Okay, what day works for you?")
        assert _first_word(f) != "okay"


def test_info_questions_never_get_a_scheduling_filler():
    # Old pool said "Let me see what's open." while looking up parking.
    for f in FILLERS_BY_KIND["info"] + FILLERS:
        assert not re.search(r"\b(open|book|booked|slot|schedule|time|you in)\b", f, re.I), f
    rng = random.Random(5)
    recent: list[str] = []
    for _ in range(100):
        f = pick_filler(recent, rng, kind="info")
        assert f in FILLERS_BY_KIND["info"] or f in FILLERS
        recent.append(f)


def test_unknown_filler_kind_falls_back_to_generic():
    assert pick_filler([], random.Random(1), kind="something-new") in FILLERS


def test_fillers_are_short_and_human():
    for f in _all_fillers() + list(ACKS):
        assert len(f.split()) <= 6, f
        assert not any(b in f.lower() for b in BANNED), f
    assert_natural(_all_fillers() + list(ACKS), conversation=False)


def test_each_kind_has_enough_variety_to_rotate():
    for kind, pool in FILLERS_BY_KIND.items():
        assert len(set(pool)) == len(pool), kind
        assert len({_first_word(f) for f in pool + FILLERS}) >= 4, kind


def test_acks_rotate_too():
    rng = random.Random(9)
    recent: list[str] = []
    for _ in range(100):
        a = pick_ack(recent, rng)
        assert a not in recent[-2:]
        recent.append(a)


def _first_word(s: str) -> str:
    return re.sub(r"[^\w']", "", s.split()[0].lower())


def _all_fillers() -> list[str]:
    return list(FILLERS) + [f for pool in FILLERS_BY_KIND.values() for f in pool]


# ── Prompt ───────────────────────────────────────────────────────────────────────────────────────────────────────

def test_style_and_guardrails_reach_the_model():
    text = build_instructions("You are Ava at Kemi Cuts.")
    assert "contractions" in text and "<data>" in text
    assert text.index("Ava at Kemi Cuts") < text.index(VOICE_STYLE.strip()[:40]) < text.index(GUARDRAILS.strip()[:40])


def test_prompt_knows_the_greeting_already_played():
    # Without this the model re-introduces itself ("Hi, I'm Ava, the AI receptionist...") on its first reply.
    assert "already played" in VOICE_STYLE and "Don't introduce yourself again" in VOICE_STYLE


def test_prompt_says_tool_times_the_spoken_way():
    # agent.py hands slots over as {"start": ISO, "say_it_like": "..."}; the model must use the second one.
    assert "say_it_like" in VOICE_STYLE
    assert "phone numbers" in VOICE_STYLE and "thirty-five" in VOICE_STYLE


def test_prompt_leads_with_the_answer_after_a_filler():
    # A filler is spoken outside the chat context, so the model doesn't know "one sec" already played.
    assert "lead with it" in VOICE_STYLE


def test_prompt_forbids_unspeakable_formatting_and_keeps_turns_short():
    assert "spoken aloud" in VOICE_STYLE
    assert "No lists, markdown, emoji" in VOICE_STYLE
    assert "40 words" in VOICE_STYLE


def test_prompt_handles_are_you_a_robot_honestly():
    assert "real person" in VOICE_STYLE and "honest" in VOICE_STYLE


def _prompt_examples() -> tuple[list[str], list[str]]:
    never_at = VOICE_STYLE.index("Never say:")
    do = re.findall(r"\"([^\"]+)\"", VOICE_STYLE[:never_at])
    dont = re.findall(r"\"([^\"]+)\"", VOICE_STYLE[never_at:])
    return do, dont


def test_every_example_the_prompt_teaches_is_natural():
    do, _ = _prompt_examples()
    assert len(do) >= 10
    assert_natural(do, conversation=False)


def test_every_never_say_phrase_is_caught_by_the_checker():
    _, dont = _prompt_examples()
    assert len(dont) >= 6
    for phrase in dont:
        assert style_issues(phrase), f"checker misses {phrase!r}; add it to packages/conversation-style"


# ── Turn-taking and TTS tuning ───────────────────────────────────────────────────────────────────────────────────

def test_tuning_is_expressive_and_interruptible():
    assert session_kwargs()["allow_interruptions"] is True
    assert tts_voice_settings()["stability"] < 0.6
    assert DEFAULT_TUNING.filler_after_ms <= 800


def test_every_tuning_value_documents_where_it_came_from():
    for f in dataclasses.fields(DEFAULT_TUNING):
        p = TUNING_PROVENANCE.get(f.name)
        assert p is not None, f"{f.name} has no provenance"
        assert p.status in {"decided", "provisional", "measured"}, f.name
        assert p.source.strip(), f.name
        if p.status == "measured":
            assert "E8" in p.source and p.evidence.strip(), f.name
        if p.status == "provisional":
            assert p.decide_by.strip(), f"{f.name}: say what measurement will settle it"


def test_endpointing_and_interruption_values_come_from_e8_or_are_flagged_provisional():
    # Brief: these are chosen from E8 real-call measurements. Until E8 records them, they must say so.
    assert set(TURN_TAKING_FIELDS) >= {"min_endpointing_delay", "max_endpointing_delay", "min_interruption_duration",
                                       "false_interruption_timeout"}
    for name in TURN_TAKING_FIELDS:
        p = TUNING_PROVENANCE[name]
        assert p.status in {"provisional", "measured"}, name
        assert "E8" in (p.decide_by if p.status == "provisional" else p.source), name
    assert set(provisional_fields()) == {n for n, p in TUNING_PROVENANCE.items() if p.status == "provisional"}


def test_turn_taking_stays_inside_the_style_guide_ranges():
    t = DEFAULT_TUNING
    assert 0.3 <= t.min_endpointing_delay <= 0.8          # shorter cuts people off, longer is dead air
    assert t.min_endpointing_delay < t.max_endpointing_delay <= 3.0
    assert 0.3 <= t.min_interruption_duration <= 0.6     # ignore coughs and "mm-hm", still stop for "wait"
    assert t.resume_false_interruption is True           # a cough shouldn't leave the caller in silence
    assert t.false_interruption_timeout is not None and t.false_interruption_timeout <= 2.0
    assert 0.5 <= t.filler_after_ms / 1000 <= 0.8


def test_session_kwargs_match_the_pinned_livekit_agents():
    from livekit.agents import AgentSession
    params = inspect.signature(AgentSession.__init__).parameters
    for key in session_kwargs():
        assert key in params, f"AgentSession has no {key!r}; argument names drifted"


def test_turn_handling_matches_livekit_options_and_keeps_the_turn_detector():
    from livekit.agents.voice.turn import EndpointingOptions, InterruptionOptions, PreemptiveGenerationOptions, TurnHandlingOptions
    detector = object()
    th = turn_handling(detector)
    assert th["turn_detection"] is detector   # turn_handling= makes AgentSession ignore a separate turn_detection=
    assert set(th) <= set(TurnHandlingOptions.__annotations__)
    assert set(th["endpointing"]) <= set(EndpointingOptions.__annotations__)
    assert set(th["interruption"]) <= set(InterruptionOptions.__annotations__)
    assert set(th["preemptive_generation"]) <= set(PreemptiveGenerationOptions.__annotations__)
    assert th["endpointing"]["min_delay"] == DEFAULT_TUNING.min_endpointing_delay
    assert th["interruption"]["min_duration"] == DEFAULT_TUNING.min_interruption_duration
    assert th["interruption"]["enabled"] is True
    assert "turn_detection" not in turn_handling()


def test_voice_settings_build_for_the_pinned_elevenlabs_plugin():
    from livekit.plugins import elevenlabs
    elevenlabs.VoiceSettings(**tts_voice_settings())
    assert DEFAULT_TUNING.tts_model.startswith("eleven_flash")


# ── A/B listening test: 3 voices x 2 stability settings on 10 scripted calls ─────────────────────────────────────

def test_ab_matrix_is_three_voices_by_two_stabilities():
    trials = ab_trials(["v1", "v2", "v3"])
    assert len(trials) == 6
    assert {(t.voice_id, t.stability) for t in trials} == {(v, s) for v in ("v1", "v2", "v3") for s in AB_STABILITY}
    assert len({t.label for t in trials}) == 6
    assert len(AB_STABILITY) == 2 and all(0.2 <= s < 0.6 for s in AB_STABILITY)
    assert trial_tuning(trials[0]).stability == trials[0].stability
    assert trial_tuning(trials[0]).min_endpointing_delay == DEFAULT_TUNING.min_endpointing_delay
    for bad in (["v1", "v2"], ["v1", "v1", "v2"], ["v1", "v2", ""]):
        with pytest.raises(ValueError):
            ab_trials(bad)


def test_ten_scripted_calls_with_zero_style_errors():
    assert len(AB_CALL_SCRIPTS) == 10
    assert len({c.name for c in AB_CALL_SCRIPTS}) == 10
    for call in AB_CALL_SCRIPTS:
        assert "AI" in call.agent_lines[0] and "recorded" in call.agent_lines[0], call.name
        assert_natural(list(call.agent_lines), person=call.person)


def test_scripted_calls_cover_what_tts_gets_wrong():
    spoken = " ".join(line for c in AB_CALL_SCRIPTS for line in c.agent_lines).lower()
    for must in ("kemi", "thirty-five", "two one four", "three-thirty", "sorry", "?", "!", "one sec"):
        assert must in spoken, must


# ── Pronunciation (ElevenLabs aliases) ──────────────────────────────────────────────────────────────────────────

PRONS = [Pronunciation("Kemi", "Keh-mee"), Pronunciation("Kemi Cuts", "Keh-mee Cuts"), Pronunciation("Nnamdi", "Nahm-dee")]


def test_alias_rules_are_elevenlabs_alias_rules_longest_first():
    rules = elevenlabs_alias_rules(PRONS + [Pronunciation("kemi", "dupe")])
    assert rules[0] == {"type": "alias", "string_to_replace": "Kemi Cuts", "alias": "Keh-mee Cuts"}
    assert [r["string_to_replace"] for r in rules] == ["Kemi Cuts", "Nnamdi", "Kemi"]
    req = pronunciation_dictionary_request("Kemi Cuts", PRONS)
    assert req["rules"] == elevenlabs_alias_rules(PRONS) and "Kemi Cuts" in req["name"]
    with pytest.raises(ValueError):
        elevenlabs_alias_rules([Pronunciation(" ", "x")])


def test_pronunciation_locators_build_for_the_pinned_plugin():
    from livekit.plugins.elevenlabs import PronunciationDictionaryLocator
    locs = pronunciation_locators("dict123", "ver456")
    assert locs == [PronunciationDictionaryLocator(pronunciation_dictionary_id="dict123", version_id="ver456")]
    assert pronunciation_locators(None, None) == []


def _run_transform(chunks: list[str], prons=PRONS) -> str:
    async def src():
        for c in chunks:
            yield c

    async def go():
        return "".join([part async for part in alias_transform(prons)(src())])

    return asyncio.run(go())


def test_alias_transform_says_names_right_even_when_split_across_chunks():
    assert _run_transform(["Thanks for calling Ke", "mi C", "uts! Nnam", "di will call you."]) == \
        "Thanks for calling Keh-mee Cuts! Nahm-dee will call you."
    assert _run_transform(["Ask ", "kemi", " about it."]) == "Ask Keh-mee about it."


def test_alias_transform_leaves_other_words_alone():
    assert _run_transform(["Kemistry and Kem", "is are fine, so is xKemi."]) == "Kemistry and Kemis are fine, so is xKemi."
    assert _run_transform(["x", "Kemi Cuts"]) == "xKemi Cuts"
    assert _run_transform(["See you at Kemi"]) == "See you at Keh-mee"
    assert _run_transform(["Hi there."], prons=[]) == "Hi there."


def test_tts_text_transforms_keep_the_builtin_filters():
    assert tts_text_transforms([]) == ["filter_markdown", "filter_emoji"]
    t = tts_text_transforms(PRONS)
    assert t[:2] == ["filter_markdown", "filter_emoji"] and callable(t[2])


# ── Cross-check against the real TypeScript checker (the CI conversation-style gate) ───────────────────────────────

def _tsx() -> Path | None:
    p = REPO / "node_modules" / ".bin" / "tsx"
    return p if p.exists() else None


@pytest.mark.skipif(_tsx() is None, reason="node_modules not installed; the Python mirror above still runs")
def test_voice_scenarios_pass_the_real_conversation_style_checker(tmp_path: Path):
    do, dont = _prompt_examples()
    conversations = [{"name": c.name, "person": c.person, "lines": list(c.agent_lines)} for c in AB_CALL_SCRIPTS]
    singles = _all_fillers() + list(ACKS) + do
    payload = tmp_path / "in.json"
    payload.write_text(json.dumps({"conversations": conversations, "singles": singles, "dont": dont}))
    script = tmp_path / "check.ts"
    script.write_text(
        f"import {{ readFileSync }} from 'node:fs';\n"
        f"import {{ checkConversation, checkReply, naturalnessScore }} from {json.dumps(str(REPO / 'packages/conversation-style/src/index.ts'))};\n"
        f"const p = JSON.parse(readFileSync({json.dumps(str(payload))}, 'utf8'));\n"
        "const out = { conversations: p.conversations.map((c: any) => checkConversation(c.lines.map((text: string) => ({ role: 'agent', text })), 'voice', c.person ?? undefined)),\n"
        "  singles: p.singles.map((s: string) => { const i = checkReply(s, { channel: 'voice' }); return { s, i, score: naturalnessScore(i) }; }),\n"
        "  dont: p.dont.map((s: string) => ({ s, n: checkReply(s, { channel: 'voice' }).length })) };\n"
        "console.log(JSON.stringify(out));\n"
    )
    res = subprocess.run([str(_tsx()), str(script)], capture_output=True, text=True, timeout=120, cwd=REPO)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout.strip().splitlines()[-1])
    for conv in out["conversations"]:
        for turn in conv:
            assert not [i for i in turn["issues"] if i["severity"] == "error"], turn
            assert turn["score"] >= 85, turn
    for s in out["singles"]:
        assert not [i for i in s["i"] if i["severity"] == "error"] and s["score"] >= 85, s
    for d in out["dont"]:
        assert d["n"] > 0, f"TS checker misses never-say phrase {d['s']!r}"


def test_python_mirror_flags_the_old_robotic_lines():
    """Sanity: the mirror is strict enough to have caught what used to slip through."""
    assert style_issues("I apologize for any inconvenience.")
    assert style_issues("Your slot is 2026-10-06T20:00.")
    assert ("verbatim-repeat", "error") in style_issues("Let me check that.", ["Let me check that."])
    assert ("repeated-opener", "warn") in style_issues("Let me see what's open.", ["Let me see that."])
