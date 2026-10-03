from frontdesk.sip import booking_idempotency_key, mask_caller, normalize_e164, sip_info_from_attributes


def test_normalizes_common_forms():
    assert normalize_e164("+1 (214) 555-0123") == "+12145550123"
    assert normalize_e164("2145550123") == "+12145550123"
    assert normalize_e164("sip:+12145550123@sip.telnyx.com") == "+12145550123"
    assert normalize_e164("not a number") is None
    assert normalize_e164(None) is None


def test_dialed_number_decides_tenant_not_caller():
    info = sip_info_from_attributes({"sip.trunkPhoneNumber": "+19725550100", "sip.phoneNumber": "+12145550123", "sip.callID": "abc"})
    assert info.dialed == "+19725550100"
    assert info.caller == "+12145550123"
    assert info.call_id == "abc"


def test_booking_key_is_stable_per_call_slot_service():
    a = booking_idempotency_key("call1", "2026-10-06T20:00:00.000Z", "cut")
    assert a == booking_idempotency_key("call1", "2026-10-06T20:00:00.000Z", "cut")
    assert a != booking_idempotency_key("call2", "2026-10-06T20:00:00.000Z", "cut")


def test_missing_attributes_mean_no_tenant_and_no_crash():
    info = sip_info_from_attributes({})
    assert info.dialed is None and info.caller is None and info.call_id == ""


def test_a_spoofable_caller_id_never_becomes_the_dialed_number():
    info = sip_info_from_attributes({"sip.phoneNumber": "+19725550100", "sip.callID": "abc"})
    assert info.dialed is None


def test_call_id_falls_back_to_the_full_sip_call_id():
    assert sip_info_from_attributes({"sip.callIDFull": "full-1"}).call_id == "full-1"


def test_callers_are_masked_before_they_reach_events_and_logs():
    assert mask_caller("+12145550123") == "***0123"
    assert mask_caller(None) == ""
    assert "214" not in mask_caller("+12145550123")


def test_booking_key_changes_with_the_slot_and_service():
    base = booking_idempotency_key("call1", "2026-10-06T20:00:00.000Z", "cut")
    assert base != booking_idempotency_key("call1", "2026-10-06T21:00:00.000Z", "cut")
    assert base != booking_idempotency_key("call1", "2026-10-06T20:00:00.000Z", "beard")
    assert base.startswith("bk-") and len(base) == 35
