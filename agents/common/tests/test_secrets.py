"""A1: the onboarding signing key comes from Secrets Manager (SEC-22), never from the command line in a deployed runtime."""
import json

import pytest

from common.secrets import SecretUnavailable, load_onboarding_signing_secret, reset_cache

KEY = "k" * 32


class FakeSm:
    def __init__(self, secrets: dict[str, str] | Exception):
        self.secrets = secrets
        self.calls: list[str] = []

    def get_secret_value(self, SecretId: str):
        self.calls.append(SecretId)
        if isinstance(self.secrets, Exception):
            raise self.secrets
        if SecretId not in self.secrets:
            raise KeyError(SecretId)
        return {"SecretString": self.secrets[SecretId]}


@pytest.fixture(autouse=True)
def clean():
    reset_cache()
    yield
    reset_cache()


def test_reads_the_key_from_the_runtime_secret_json():
    sm = FakeSm({"1145/dev/runtime": json.dumps({"ONBOARDING_SERVICE_TOKEN": KEY, "TELEGRAM_BOT_TOKEN": "t"})})
    assert load_onboarding_signing_secret({"RUNTIME_SECRET_ID": "1145/dev/runtime"}, client=sm) == KEY


def test_reads_a_dedicated_secret_bare_or_json_the_way_d9_stores_it():
    bare = FakeSm({"arn:aws:secretsmanager:x:1:secret:onb": KEY})
    assert load_onboarding_signing_secret({"ONBOARDING_SERVICE_TOKEN_SECRET_ARN": "arn:aws:secretsmanager:x:1:secret:onb"}, client=bare) == KEY
    reset_cache()
    js = FakeSm({"arn:aws:secretsmanager:x:1:secret:onb": json.dumps({"current": KEY, "previous": "p" * 32})})
    assert load_onboarding_signing_secret({"ONBOARDING_SERVICE_TOKEN_SECRET_ARN": "arn:aws:secretsmanager:x:1:secret:onb"}, client=js) == KEY


def test_the_dedicated_secret_wins_over_the_runtime_secret():
    sm = FakeSm({"dedicated": KEY, "runtime": json.dumps({"ONBOARDING_SERVICE_TOKEN": "z" * 32})})
    assert load_onboarding_signing_secret({"ONBOARDING_SERVICE_TOKEN_SECRET_ARN": "dedicated", "RUNTIME_SECRET_ID": "runtime"}, client=sm) == KEY


def test_the_key_is_cached_for_a_few_minutes_not_fetched_every_turn():
    sm = FakeSm({"r": json.dumps({"ONBOARDING_SERVICE_TOKEN": KEY})})
    now = [1000.0]
    env = {"RUNTIME_SECRET_ID": "r"}
    for _ in range(5):
        load_onboarding_signing_secret(env, client=sm, clock=lambda: now[0])
    assert len(sm.calls) == 1
    now[0] += 301
    load_onboarding_signing_secret(env, client=sm, clock=lambda: now[0])
    assert len(sm.calls) == 2


def test_a_configured_secret_that_fails_never_falls_back_to_the_env_value():
    sm = FakeSm(RuntimeError("AccessDenied"))
    env = {"RUNTIME_SECRET_ID": "r", "ONBOARDING_SERVICE_TOKEN": KEY}
    with pytest.raises(SecretUnavailable):
        load_onboarding_signing_secret(env, client=sm)


@pytest.mark.parametrize("secret_string", ["", "short", "{}", json.dumps({"ONBOARDING_SERVICE_TOKEN": "short"}), json.dumps({"other": KEY}), "{not json"])
def test_unusable_secret_contents_are_an_error(secret_string):
    with pytest.raises(SecretUnavailable):
        load_onboarding_signing_secret({"RUNTIME_SECRET_ID": "r"}, client=FakeSm({"r": secret_string}))


def test_local_dev_may_use_the_env_value_when_no_secret_is_configured():
    assert load_onboarding_signing_secret({"ONBOARDING_SERVICE_TOKEN": KEY}) == KEY


def test_nothing_configured_is_an_error():
    with pytest.raises(SecretUnavailable):
        load_onboarding_signing_secret({})


def test_errors_never_contain_the_secret_value():
    with pytest.raises(SecretUnavailable) as e:
        load_onboarding_signing_secret({"RUNTIME_SECRET_ID": "r"}, client=FakeSm({"r": json.dumps({"ONBOARDING_SERVICE_TOKEN": "too-short-key"})}))
    assert "too-short-key" not in str(e.value)
