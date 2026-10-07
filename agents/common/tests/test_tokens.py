"""A1: the per-invocation onboarding token (SEC-22, CR D1-3 section 1). Must verify against services/provisioning/src/api/basics.ts."""
import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from common.tokens import MAX_TTL_SECONDS, mint_onboarding_token

SECRET = "test-onboarding-signing-key-0123456789"
REPO_ROOT = Path(__file__).resolve().parents[3]

# Produced by mintOnboardingToken('o_abc123XYZ', SECRET, 900, 1_700_000_000) in basics.ts, and verified by verifyOnboardingToken.
TS_GOLDEN = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvbmIiOiJvX2FiYzEyM1hZWiIsImF1ZCI6Im9uYm9hcmRpbmctYXBpIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDA5MDB9"
             ".5QV8S1DuspcHLkVItpEpYlxWUdNBPGs-LWYhlJ2oMeI")


def claims_of(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def test_matches_the_typescript_minter_byte_for_byte():
    assert mint_onboarding_token("o_abc123XYZ", SECRET, ttl=900, now=1_700_000_000) == TS_GOLDEN


def test_claims_name_exactly_one_onboarding_and_expire_within_15_minutes():
    t = mint_onboarding_token("o_abc123XYZ", SECRET, now=1_700_000_000)
    assert claims_of(t) == {"onb": "o_abc123XYZ", "aud": "onboarding-api", "iat": 1_700_000_000, "exp": 1_700_000_900}
    assert MAX_TTL_SECONDS == 900


def test_different_onboardings_get_different_tokens():
    a = mint_onboarding_token("o_AAAA", SECRET, now=1_700_000_000)
    b = mint_onboarding_token("o_BBBB", SECRET, now=1_700_000_000)
    assert a != b and claims_of(a)["onb"] == "o_AAAA" and claims_of(b)["onb"] == "o_BBBB"


def test_defaults_to_now():
    import time
    before = int(time.time())
    c = claims_of(mint_onboarding_token("o_abc123", SECRET))
    assert before <= c["iat"] <= int(time.time()) and c["exp"] - c["iat"] == 900


@pytest.mark.parametrize("ttl", [0, -5, 901, 3600])
def test_ttl_is_capped_at_900_seconds(ttl):
    with pytest.raises(ValueError):
        mint_onboarding_token("o_abc123", SECRET, ttl=ttl)


@pytest.mark.parametrize("secret", ["", "short", "x" * 15])
def test_short_secrets_are_refused_because_the_api_would_ignore_them(secret):
    with pytest.raises(ValueError):
        mint_onboarding_token("o_abc123", secret)


@pytest.mark.parametrize("onboarding_id", ["", "ab", "has space", "o_abc/../../x", "o_abc\n", "x" * 65, "o_ünï"])
def test_ids_the_api_would_reject_are_never_signed(onboarding_id):
    with pytest.raises(ValueError):
        mint_onboarding_token(onboarding_id, SECRET)


def test_the_secret_never_appears_in_the_token_or_an_error():
    t = mint_onboarding_token("o_abc123", SECRET)
    assert SECRET not in t
    with pytest.raises(ValueError) as e:
        mint_onboarding_token("bad id", SECRET)
    assert SECRET not in str(e.value)


@pytest.mark.skipif(not (REPO_ROOT / "node_modules" / ".bin" / "tsx").exists() or not shutil.which("node"), reason="tsx not installed")
def test_the_real_verifier_accepts_a_python_minted_token(tmp_path):
    token = mint_onboarding_token("o_abc123XYZ", SECRET, now=1_700_000_000)
    script = tmp_path / "verify.mts"
    script.write_text(
        f"import {{ verifyOnboardingToken }} from {json.dumps((REPO_ROOT / 'services/provisioning/src/api/basics.ts').as_uri())};\n"
        "const [t, s] = process.argv.slice(2);\n"
        "console.log(JSON.stringify(verifyOnboardingToken(t, [s], 1_700_000_100)));\n"
    )
    p = subprocess.run([str(REPO_ROOT / "node_modules/.bin/tsx"), str(script), token, SECRET], capture_output=True, text=True, timeout=120, cwd=REPO_ROOT)
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout.strip().splitlines()[-1]) == {"onb": "o_abc123XYZ", "aud": "onboarding-api", "iat": 1_700_000_000, "exp": 1_700_000_900}
