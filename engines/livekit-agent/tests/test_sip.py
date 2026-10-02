from frontdesk.sip import booking_idempotency_key, normalize_e164, sip_info_from_attributes


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
