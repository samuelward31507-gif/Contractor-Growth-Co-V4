/**
 * Agent Operating Layer: the internal Command Center (/insights/intelligence)
 * renders inside the Agency Command Center's own shell - the exact same
 * layout as /agency (signed-in check, Agency sidebar, no contractor
 * navigation). Re-exported, not copied, so the two shells can never drift.
 * Authorization is still decided per page, server-side, through
 * is_agency_admin() - never by this shell.
 */
export { default } from "../agency/layout";
