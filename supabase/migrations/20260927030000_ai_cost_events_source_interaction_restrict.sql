-- Trackpr Phase 5D-2 - correct ai_cost_events.source_interaction_id's
-- delete behavior from CASCADE to RESTRICT.
--
-- Found during final pre-deploy review: 20260927000000_ai_cost_intelligence.sql
-- gave source_interaction_id "on delete cascade", which is inconsistent with
-- ai_cost_events' own stated design intent (an immutable, append-only
-- financial audit record - "a later rate_cards correction can never
-- retroactively change what this row reports") and with the choice already
-- made, in the very same migration, for rate_card_input_id/
-- rate_card_output_id (both left with no ON DELETE clause, i.e. RESTRICT by
-- default - a rate card that produced a real cost can never be deleted).
-- CASCADE on source_interaction_id let the OTHER half of that same audit
-- trail silently vanish instead.
--
-- Confirmed by inspection this is safe to tighten with no behavior change to
-- any existing code path: no application code anywhere calls .delete() on
-- organizations or ai_interactions. ai_interactions.contact_id/lead_id/
-- conversation_id all already use ON DELETE SET NULL (see
-- 20260923030500_restrict_contact_delete_on_revenue_tables.sql's own note
-- that ai_interactions intentionally keeps SET NULL there), so deleting a
-- contact/lead/conversation never deletes an ai_interactions row. The only
-- way an ai_interactions row is removed today is the organization-level
-- cascade (ai_interactions.organization_id ON DELETE CASCADE) - and
-- ai_cost_events already cascades independently and symmetrically in that
-- same scenario via its OWN organization_id FK, so this change has zero
-- effect on that path. It only closes the gap for a hypothetical future
-- feature that deletes a single ai_interactions row directly: with CASCADE,
-- that would silently destroy a real, priced historical cost record; with
-- RESTRICT, that delete is instead rejected until the cost event itself is
-- resolved - mirroring the exact appointments/estimates/jobs-vs-contacts
-- precedent.

alter table public.ai_cost_events
  drop constraint ai_cost_events_source_interaction_id_fkey,
  add constraint ai_cost_events_source_interaction_id_fkey
    foreign key (source_interaction_id) references public.ai_interactions(id) on delete restrict;
