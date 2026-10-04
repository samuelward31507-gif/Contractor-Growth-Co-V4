"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonSmallClass, successBannerClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import type { TeamMemberRow } from "@/lib/team/queries";
import { ROLE_LABEL } from "@/lib/team/rules";
import { changeTeamMemberRole, inviteTeamMember, regenerateInviteLink, removeTeamMember, type TeamActionState } from "../team/actions";

const initialState: TeamActionState = {};

/**
 * Phase 3 (W3): Settings -> Team. Owners and admins invite staff as Admin or
 * Member by a copyable link (Trackpr sends no email), change roles and
 * remove people; members see the team read-only. The owner's row and your
 * own row have no actions.
 */
export function TeamSection({ members, currentUserId, canEdit, failed }: { members: TeamMemberRow[]; currentUserId: string; canEdit: boolean; failed: boolean }) {
  const [inviteState, inviteAction, invitePending] = useActionState(inviteTeamMember, initialState);
  const [linkState, linkAction, linkPending] = useActionState(regenerateInviteLink, initialState);
  const [roleState, roleAction, rolePending] = useActionState(changeTeamMemberRole, initialState);
  const [removeState, removeAction, removePending] = useActionState(removeTeamMember, initialState);
  const latestLink = linkState.inviteLink ? linkState : inviteState.inviteLink ? inviteState : null;
  const status = [roleState, removeState, linkState, inviteState].find((state) => state.error) ?? [roleState, removeState].find((state) => state.success);

  return (
    <section>
      <h2 className={subsectionTitleClass}>Team</h2>
      <p className={`mt-1 ${metaClass}`}>
        Everyone who can sign in to this workspace. Admins can change settings and manage the team; members can work with customers, money and the schedule.
      </p>

      {failed ? <p className={`mt-4 ${errorBannerClass}`} role="alert">The team couldn&apos;t be loaded. Please try again.</p> : null}
      {status?.error ? <p className={`mt-4 ${errorBannerClass}`} role="alert">{status.error}</p> : null}
      {status?.success ? <p className={`mt-4 ${successBannerClass}`}>{status.success}</p> : null}

      <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
        {members.map((member) => {
          const editable = canEdit && member.userId !== currentUserId && member.role !== "owner";
          return (
            <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{member.email ?? "Unknown email"}{member.userId === currentUserId ? " (you)" : ""}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={member.role === "owner" ? "success" : "neutral"}>{ROLE_LABEL[member.role]}</Badge>
                  {member.invited ? <Badge tone="warning">Invite not accepted yet</Badge> : null}
                </div>
              </div>
              {editable ? (
                <div className="flex flex-wrap items-center gap-2">
                  <form action={roleAction} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={member.userId} />
                    <label className="sr-only" htmlFor={`role-${member.userId}`}>Role</label>
                    <select id={`role-${member.userId}`} name="role" defaultValue={member.role} className={`${inputClass} w-auto py-1.5`} disabled={rolePending}>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                    <button type="submit" className={`${secondaryButtonSmallClass} whitespace-nowrap`} disabled={rolePending}>Save role</button>
                  </form>
                  {member.invited ? (
                    <form action={linkAction}>
                      <input type="hidden" name="userId" value={member.userId} />
                      <button type="submit" className={secondaryButtonSmallClass} disabled={linkPending}>New invite link</button>
                    </form>
                  ) : null}
                  <form action={removeAction}>
                    <input type="hidden" name="userId" value={member.userId} />
                    <button type="submit" className={`${secondaryButtonSmallClass} text-danger-text`} disabled={removePending}>Remove</button>
                  </form>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {latestLink?.inviteLink ? <InviteLink email={latestLink.inviteEmail ?? ""} link={latestLink.inviteLink} /> : null}

      {canEdit ? (
        <form action={inviteAction} className="mt-5">
          <fieldset disabled={invitePending} className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
            <div className="space-y-1.5">
              <label htmlFor="inviteEmail" className={labelClass}>Invite by email</label>
              <input id="inviteEmail" name="email" type="email" required className={inputClass} placeholder="office@company.com" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="inviteRole" className={labelClass}>Role</label>
              <select id="inviteRole" name="role" defaultValue="member" className={inputClass}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button type="submit" className={primaryButtonAutoClass}>{invitePending ? "Creating link…" : "Create invite link"}</button>
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}

function InviteLink({ email, link }: { email: string; link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-lg border border-line bg-canvas/60 px-4 py-3">
      <p className="text-sm font-medium text-ink">Invite link for {email}</p>
      <p className={`mt-1 ${metaClass}`}>Send this to them yourself - Trackpr doesn&apos;t email it. It works once and expires after about an hour; create a new one any time.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input readOnly value={link} aria-label="Invite link" className={`${inputClass} min-w-0 flex-1 font-mono text-xs`} onFocus={(event) => event.currentTarget.select()} />
        <button
          type="button"
          className={secondaryButtonSmallClass}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
