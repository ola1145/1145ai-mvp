# ADR-0004: SMS and customer WhatsApp are async unlocks

**Status:** Proposed · **Date:** 2026-10-02

## Context
US 10DLC requires a brand and campaign per tenant; carriers block unregistered traffic. A tenant-owned WhatsApp
number needs a WABA, business verification and display-name approval. Neither completes in minutes.

## Decision
A tenant goes live on voice and web chat during onboarding. Each tenant has `channels.sms` and `channels.whatsapp`
with states `not_requested → submitted → approved → active | rejected`. The provisioning workflow submits the
paperwork; an approval event flips the channel to active and the admin agent tells the owner.

## Consequences
Zero-touch promise holds for the core product. Booking confirmations by text wait for SMS approval; email is the
interim channel. Start 1145's own ISV/BSP registrations in Wave 0 so the per-tenant steps are quick.
