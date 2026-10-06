"""
Onboarding tools. Every tool is a closure over onboarding_id, which the ROUTER put in the payload from the
verified channel identity. No tool takes an id argument, so the model cannot redirect a tool to another onboarding.
The agent asks; the Step Functions workflow does (Change-7): one tool starts provisioning, one reads status.

What a tool returns is read by the model and often paraphrased to the owner, so it follows 1145-conversation-style
too: plain words, no call-center phrasing, and it never says something worked when it didn't.
"""
from __future__ import annotations

import json
import re
from typing import Callable

from common.api import Api, as_data

HEALTHCARE = re.compile(r"\b(dent(al|ist)|clinic|doctor|physician|medical|therap(y|ist)|chiro|pharmac|hospital|health ?care|optomet|psychiat|counsel)", re.I)
MAX_AGENT_NAME = 40


def _failed(r: dict) -> bool:
    return "error" in r


def _unique(ids: list[str]) -> list[str]:
    return list(dict.fromkeys(i for i in ids if i))


def make_onboarding_tools(api: Api, onboarding_id: str) -> list[Callable[..., str]]:
    base = f"/internal/onboarding/{onboarding_id}"

    def save_business_basics(business_name: str, business_type: str, city_or_area: str, website: str = "") -> str:
        """Save the business name, what kind of business it is (e.g. barber, salon, auto repair), its city or area, and its website if it has one."""
        if HEALTHCARE.search(business_type) or HEALTHCARE.search(business_name):
            api.post(f"{base}/waitlist", {"reason": "healthcare"})
            return ("Healthcare businesses are not supported yet, and they're now on the waitlist. Tell them that "
                    "plainly and warmly in a line or two, and stop setup here. Don't send a sign-up link.")
        r = api.post(f"{base}/basics", {"businessName": business_name, "businessType": business_type, "area": city_or_area, "website": website or None})
        if _failed(r):
            return "That didn't save. Say sorry, it didn't go through, and ask them to send it once more."
        return "Saved."

    def send_signup_link() -> str:
        """Telegram only: send the owner a private sign-up link as a separate message. The link is never shown to you."""
        r = api.post(f"{base}/signup-link", {})
        if _failed(r):
            return "The link didn't send. Tell them it didn't go through and that you'll send it again in a moment."
        return ("The sign-up link was sent. Ask them to tap it and sign in with Google, then reply YES to the message "
                "that pops up here.")

    def start_provisioning(preferred_area_code: str = "") -> str:
        """Start setting up the phone number, knowledge and agent. Only works after Google sign-in is confirmed."""
        r = api.post(f"{base}/provisioning", {"preferredAreaCode": preferred_area_code or None})
        if r.get("error") == "identity_not_confirmed":
            return ("Sign-in isn't confirmed yet, so nothing is set up. Ask them to finish the sign-up link and reply "
                    "YES to the confirmation message.")
        if _failed(r):
            return ("Setup didn't go through this time, so don't tell them a number is on the way. Keep going with hours "
                    "and services and try again in a minute.")
        return "Setup started. Keep going with hours and services while it runs."

    def provisioning_status() -> str:
        """Check how setup is going (number, forwarding steps, knowledge, profile, agent name, test call)."""
        r = api.get(f"{base}/provisioning")
        if _failed(r):
            return "Couldn't check on setup just now. Don't guess the number; try again in a moment."
        return as_data(json.dumps(r))

    def save_hours(hours_in_owners_words: str) -> str:
        """Save opening hours exactly as the owner described them, e.g. 'Tue-Sat 9 to 6, closed Sun and Mon'."""
        r = api.post(f"{base}/hours", {"text": hours_in_owners_words})
        if _failed(r):
            return "Those hours didn't save. Tell them it didn't go through and ask them to send the hours again."
        return as_data(json.dumps(r.get("parsed", r))) + "\nRead the parsed hours back as a short list and ask if that's right."

    def save_services(services_in_owners_words: str) -> str:
        """Save services with durations and prices as the owner described them."""
        r = api.post(f"{base}/services", {"text": services_in_owners_words})
        if _failed(r):
            return "Those services didn't save. Tell them it didn't go through and ask them to send the list again."
        return as_data(json.dumps(r.get("parsed", r))) + "\nRead them back as a short list and ask if that's right."

    def facts_to_confirm() -> str:
        """Get facts found on the owner's website/listings that the owner must confirm before customers hear them."""
        r = api.get(f"{base}/facts", {"status": "pending"})
        if _failed(r):
            return "Couldn't load the facts just now. Move on to naming the receptionist and come back to this later."
        if not r.get("facts"):
            return "Nothing to confirm. Skip this step and move on."
        return as_data(json.dumps(r))

    def confirm_facts(approved_fact_ids: list[str], rejected_fact_ids: list[str]) -> str:
        """Record which scraped facts the owner approved or rejected. Only approved facts are ever used with customers. Anything they're unsure about counts as rejected."""
        rejected = _unique(rejected_fact_ids)
        approved = [i for i in _unique(approved_fact_ids) if i not in rejected]
        r = api.post(f"{base}/facts/decisions", {"approved": approved, "rejected": rejected})
        if _failed(r):
            return "That didn't save. Tell them it didn't go through and ask again which ones are right."
        return "Recorded."

    def name_agent(agent_name: str) -> str:
        """Set the name the owner chose for their AI receptionist. This completes the naming step of setup."""
        name = " ".join(agent_name.split())[:MAX_AGENT_NAME].strip()
        if not name:
            return "No name came through. Ask what they'd like to call their receptionist, or offer one like Ava."
        r = api.post(f"{base}/agent-name", {"name": name})
        if _failed(r):
            return "That name didn't work. Ask for another."
        return f"Named {name}. A quick test call to the owner's phone will follow."

    return [save_business_basics, send_signup_link, start_provisioning, provisioning_status, save_hours,
            save_services, facts_to_confirm, confirm_facts, name_agent]
