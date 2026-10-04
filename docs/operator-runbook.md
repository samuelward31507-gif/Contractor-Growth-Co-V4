# Trackpr operator runbook — onboarding a contractor

Trackpr is sold as a done-for-you system ("built and managed"). This is the
operator's checklist for taking a signed contractor from first contact to
live, and for keeping them healthy afterwards. Steps marked **Operator** are
done by our team outside the app; everything else the contractor (or the
operator, signed in as the owner) does in Trackpr.

---

## 0. Before you start

- **Environment check.** Production runs on the Production Supabase project
  and live Stripe. Preview deployments use the TEST Supabase project
  (`lwofqffxagxiqodqvcfr`). **Never** rehearse payments with a live Stripe
  key: local `.env.local` currently pairs the TEST database with a *live*
  Stripe secret key — replace it with a Stripe **test** key before running
  any local checkout. Preview has no Stripe keys of its own (they are
  Production-scoped), so checkout does not work on previews.
- **Scheduled work.** All scheduled routes (opportunity sync, automations,
  owner digest, invoice reminders, health) are called by Supabase pg_cron +
  pg_net every 15 minutes with the `CRON_SECRET` bearer token — not Vercel
  Cron and not n8n. TEST has no cron.

## 1. Account and payment

1. The contractor signs up at `/signup` (or the operator does it with the
   contractor's email) and confirms the email.
2. `/onboarding` step 1: business name, owner name, phone, trade and service
   area. This creates the organization in **payment required** mode.
3. Payment: the onboarding payment step opens Stripe Checkout with the setup
   fee and the monthly management subscription (prices come from
   `STRIPE_SETUP_PRICE_ID` / `STRIPE_SUBSCRIPTION_PRICE_ID`; never change
   them per client).
4. Stripe's webhook (`/api/webhooks/stripe`, signed with
   `STRIPE_WEBHOOK_SECRET`) activates the organization. **Check:** the
   onboarding hub opens (the payment gate is gone). If it doesn't, look at the
   Stripe dashboard's webhook deliveries for that event.

## 2. Phone number and texting — Operator

1. **Operator:** buy a local Twilio number for the contractor (our Twilio
   account).
2. **Operator:** point the number's webhooks at Production:
   - Messaging (inbound SMS): `POST https://<app>/api/webhooks/sms/inbound`
   - Voice (missed calls): `POST https://<app>/api/webhooks/voice/inbound`
   - Delivery status is set per message automatically
     (`/api/webhooks/sms/status`).
3. **Operator — A2P 10DLC registration (manual, outside the app).** US
   carriers require every business texting customers to be registered under
   A2P 10DLC: register (or reuse) the contractor's brand, attach the number to
   an approved campaign, and wait for approval. **Do not Go Live until the
   number's campaign is approved** — unregistered traffic is filtered or
   blocked by carriers, and sends show up as `failed` / `undelivered`.
   Record the brand/campaign status in the client's notes.
4. In Trackpr: **Settings → SMS & Communications → Manage SMS settings**,
   enter the number in E.164 (`+1…`). **Check:** the SMS section shows
   "Configured".

## 3. Business setup (onboarding hub)

Work through the hub; each item turns green when done.

| Item | Where | Check |
|---|---|---|
| Business profile | Settings → Business profile | Name, phone, timezone correct (all times follow the timezone) |
| Trade & service area | Onboarding hub | Matches the contract |
| Business hours | Settings → Business hours | AI replies respect these when configured |
| Lead capture | Settings → Lead capture | Copy the intake URL (`/api/leads/capture/<token>`) into the contractor's website form / ad platform |
| Test lead | Onboarding hub → send a test lead | Appears in People and on Today |
| AI settings | Settings → AI | Tone, introduction, instructions reviewed with the contractor |
| Booking (optional) | Settings → Booking | Only if they want AI booking |
| Google Calendar (optional) | Settings → Calendar | Connect and choose the calendar; "connected" banner shows |
| Online payments (optional) | Settings → Online payments | Stripe Connect onboarding completed by the contractor |
| Notifications | Settings → Notifications | Owner's notification phone/email; escalation contact; weekly summary on |
| Team | Settings → Team | Invite office staff (below) |

## 4. Team access

Settings → **Team** (owners and admins).

1. Enter the person's email, choose **Member** (works customers, money and
   the schedule) or **Admin** (also changes settings and the team), and
   **Create invite link**.
2. **Trackpr does not email the invite.** Copy the link and send it to the
   person yourself (text, email). It works once and expires after about an
   hour; use **New invite link** on their row any time.
3. The person opens the link, sets a password and lands on Today.
4. Roles can be changed and people removed from the same list. The owner's
   row and your own row can't be changed there, so the workspace always keeps
   its owner. An email that already has a Trackpr account can't be invited
   (invites are for new accounts).

## 5. Go Live

1. Settings → **Automation mode**: confirm every hub item is complete, the
   texting number's A2P campaign is approved, and the contractor has seen
   their first test lead flow through.
2. Press **Go Live** (Settings → Automation mode). Until then the outbound
   gate refuses every automated customer message (test mode); **Switch to
   Test** reverses it.
3. **Check within the first hour:** Today loads, Automations shows each
   automation's state, and a real inbound text appears in the Inbox.

## 6. After go-live — first two weeks

- **Daily:** Agency Command Center → client needs-attention and incidents.
- **Weekly:** the owner digest goes out Monday morning (contractor's local
  time); confirm it arrived.
- Automations only send while Live, within the configured rules, and never
  more than 48 hours late (a scheduled touch that comes due while the system
  was paused or broken is recorded as overdue, not sent).

## 7. Failure modes and what to do

| Symptom | Likely cause | Where to look | Action |
|---|---|---|---|
| Messages show "failed to send" / undelivered | A2P campaign not approved, number misconfigured, Twilio account issue | Twilio console → message logs; Trackpr timeline shows "failed to send" | Fix registration/number; customers whose reply failed stay **waiting** on Today/People until someone replies successfully |
| "Scheduled automation is stale" incident | pg_cron / pg_net not calling a route, or a route failing | Supabase → pg_cron job runs, Postgres logs; Vercel → function logs for `/api/automation/*` | A run that can't read every candidate stops with nothing processed and is retried on the next tick; fix the cause, the next run catches up (touches more than 48h late are recorded as overdue) |
| New client stuck on payment | Stripe webhook not delivered or failed | Stripe dashboard → webhook attempts for `/api/webhooks/stripe` | Re-send the event from Stripe |
| Online payment taken but invoice not updated | Connect webhook refused by the database rules | Incident `online_payment_reconciliation` | Reconcile by hand per the incident |
| AI replies missing | n8n unreachable (`N8N_BASE_URL`), AI off for the org or conversation, outside business hours | Automation page status ("Not configured" = the n8n URL isn't set in that environment), workflow executions | Fix n8n / settings; the waiting conversation becomes a person's item on Today after the 15-minute grace |
| Owner says Today and People disagree on who's waiting | Today's SQL classification not yet updated in this environment | `supabase/pending/README.md` → `dashboard_conversation_attention_successful_reply.sql` | Apply the pending SQL (with authorization) |

## 8. Never

- Never change prices, Stripe products or a client's subscription by hand.
- Never edit n8n workflows or Twilio routing for one client without a ticket.
- Never run test suites or scripts with Production credentials.
- Never apply a SQL change to Production without following
  `supabase/pending/README.md` and reading back the result.
