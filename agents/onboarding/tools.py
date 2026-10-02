"""
Onboarding tools. Every tool is a closure over onboarding_id, which the ROUTER put in the payload from the
verified channel identity. No tool takes an id argument, so the model cannot redirect a tool to another onboarding.
The agent asks; the Step Functions workflow does (Change-7): one tool starts provisioning, one reads status.
"""
from __future__ import annotations

import json
import re
from typing import Callable

from common.api import Api, as_data

HEALTHCARE = re.compile(r"\b(dent(al|ist)|clinic|doctor|physician|medical|therap(y|ist)|chiro|pharmac|hospital|health ?care|optomet|psychiat|counsel)", re.I)


def make_onboarding_tools(api: Api, onboarding_id: str) -> list[Callable[..., str]]:
    base = f"/internal/onboarding/{onboarding_id}"

    def save_business_basics(business_name: str, business_type: str, city_or_area: str, website: str = "") -> str:
        """Save the business name, what kind of business it is (e.g. barber, salon, auto repair), its city or area, and its website if it has one."""
        if HEALTHCARE.search(business_type) or HEALTHCARE.search(business_name):
            api.post(f"{base}/waitlist", {"reason": "healthcare"})
            return "Healthcare businesses are not supported yet. Tell the owner kindly and that we've added them to the waitlist."
        r = api.post(f"{base}/basics", {"businessName": business_name, "businessType": business_type, "area": city_or_area, "website": website or None})
        return "Saved." if "error" not in r else "Could not save that. Ask the owner to repeat it."

    def send_signup_link() -> str:
        """Telegram only: send the owner a private sign-up link as a separate message. The link is never shown to you."""
        r = api.post(f"{base}/signup-link", {})
        return "The sign-up link was sent. Ask them to tap it and sign in with Google, then come back here." if "error" not in r else "Could not send the link. Try again in a moment."

    def start_provisioning(preferred_area_code: str = "") -> str:
        """Start setting up the phone number, knowledge and agent. Only works after Google sign-in is confirmed."""
        r = api.post(f"{base}/provisioning", {"preferredAreaCode": preferred_area_code or None})
        if r.get("error") == "identity_not_confirmed":
            return "Sign-in is not confirmed yet. Ask the owner to finish the sign-up link and reply YES to the confirmation message."
        return "Setup started. Keep asking about hours and services while it runs."

    def provisioning_status() -> str:
        """Check how setup is going (number, knowledge, profile, agent name, test call)."""
        return as_data(json.dumps(api.get(f"{base}/provisioning")))

    def save_hours(hours_in_owners_words: str) -> str:
        """Save opening hours exactly as the owner described them, e.g. 'Tue-Sat 9 to 6, closed Sun and Mon'."""
        r = api.post(f"{base}/hours", {"text": hours_in_owners_words})
        return as_data(json.dumps(r.get("parsed", r))) + "\nRead the parsed hours back to the owner and ask them to confirm."

    def save_services(services_in_owners_words: str) -> str:
        """Save services with durations and prices as the owner described them."""
        r = api.post(f"{base}/services", {"text": services_in_owners_words})
        return as_data(json.dumps(r.get("parsed", r))) + "\nRead them back briefly and ask the owner to confirm."

    def facts_to_confirm() -> str:
        """Get facts found on the owner's website/listings that the owner must confirm before customers hear them."""
        return as_data(json.dumps(api.get(f"{base}/facts", {"status": "pending"})))

    def confirm_facts(approved_fact_ids: list[str], rejected_fact_ids: list[str]) -> str:
        """Record which scraped facts the owner approved or rejected. Only approved facts are ever used with customers."""
        api.post(f"{base}/facts/decisions", {"approved": approved_fact_ids, "rejected": rejected_fact_ids})
        return "Recorded."

    def name_agent(agent_name: str) -> str:
        """Set the name the owner chose for their AI receptionist. This completes the naming step of setup."""
        r = api.post(f"{base}/agent-name", {"name": agent_name[:40]})
        return "Named. A test call to the owner's phone will follow." if "error" not in r else "That name didn't work. Ask for another."

    return [save_business_basics, send_signup_link, start_provisioning, provisioning_status, save_hours,
            save_services, facts_to_confirm, confirm_facts, name_agent]
