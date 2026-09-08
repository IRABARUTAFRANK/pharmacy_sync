# Multi-branch pharmacy chains — plain-language explanation

**Status: proposal only.** This document explains the design in
`PROPOSAL_multi_branch_organizations.sql` and
`PROPOSAL_multi_branch_organizations.eraser` in plain language, for
reviewing and deciding whether to approve the feature — not as a
specification in its own right. Nothing described here has been built or
turned on. Where this document and the `.sql` file ever disagree, the `.sql`
file is the source of truth; this one exists to make it readable without
having to parse SQL line by line.

---

## 1. The problem, in one sentence

Today, PharmSync treats every "branch" as a completely independent pharmacy
business with its own owner, its own stock, its own staff — there is no way
for one company to own several branches and manage them together. This
proposal adds that, without changing anything about how a single, standalone
branch works today.

---

## 2. The most important idea to understand first

**There is no single "parent branch."** This is worth stating clearly
because the natural way to describe the feature — "the parent branch manages
the sub-branches" — is not quite how it is actually built, and the real
design is better for it.

Instead, there is a new kind of record above branches, called an
**organization** (the company itself — e.g. "Kigali Pharmacy Ltd"). Several
branches can belong to the same organization, as equals — Kigali Central,
Huye Branch, and Musanze Branch would all be ordinary branches that happen
to share one organization, not one of them ranking above the others.

What actually grants "see everything" access is not being a particular
branch — it is being a **person** who is a **member of the organization**.
That person almost always is the owner of one of the branches too (most
naturally, the branch that existed first, before the company expanded), but
technically they are two separate things: their own branch, where they work
day to day, and their organization membership, which is what lets them also
see the other branches. This separation is what makes it possible, later,
for a chain to have more than one such person (co-owners, a hired regional
manager) without redesigning anything.

---

## 3. The four new tables, in plain language

### `pharmacy_organizations` — the company record

One row per company. Holds the company's legal name, its own registered
tax number (TIN — see §9 on why this matters for Rwanda specifically), and
whether the company itself is active or suspended. It does not hold any
stock, any sales, any staff directly — it is purely the umbrella that
branches attach themselves to.

### `organization_members` — who can see across branches, and how much

One row per person who has been granted cross-branch access, naming which
organization, which person, and their level:

- **`org_owner`** — full control: can add new branches to the company, can
  grant or revoke other people's cross-branch access, can see everything.
- **`org_manager`** — the same cross-branch *visibility* and day-to-day
  oversight (reports, approving stock transfers) as an owner, but cannot
  restructure the company itself (cannot add branches or manage who else has
  access).

A person keeps their existing, single branch exactly as before — this table
only ever *adds* the ability to also see other branches, on top of that,
never replaces it.

### `stock_transfers` — the paper trail for moving stock between branches

One row per shipment of stock from one branch to another. Records which
branch it is coming from, which branch it is going to, who asked for it, who
approved it, and what state it is currently in: requested, approved, on its
way, or received. This is the *record of the movement*, not the stock
itself.

### `stock_transfer_items` — exactly what is in that shipment

One row per batch of medicine included in a transfer. If Kigali Central
sends three different batches of medicine to Huye in one shipment, that is
one `stock_transfers` row and three `stock_transfer_items` rows underneath
it.

---

## 4. How the new tables connect — column by column

This section is the one to lean on if you need to explain the mechanics to
someone else, table by table. The short version to lead with: **every new
table either points straight at `pharmacy_organizations`, or points at a
table that already existed.** None of the new tables invent new facts about
people, medicine, or money — they only add new *relationships* between facts
that already live somewhere in the system, plus a little bookkeeping
(status, timestamps, who-did-what) for the transfer workflow.

Going through each one:

### `pharmacy_organizations` — points at nothing; everything else points at it

It has no foreign key of its own going *out* to another table — it is the
anchor at the top. Three other things point *in* to it, each one meaning
"belongs to this company": `branches.organization_id`,
`organization_members.organization_id`, and
`stock_transfers.organization_id`.

### `branches.organization_id` — one new column on the existing `branches` table

This is not a new table at all — it is one new, optional column added to the
`branches` table you already have. It points at `pharmacy_organizations.id`.

- **Relationship:** one organization → many branches. A branch can point at
  at most one organization (it is a plain column, not a table linking many
  branches to many organizations) — matching the real-world fact that a
  pharmacy cannot be simultaneously independent and part of a chain.
- **When it is left empty (`null`):** the branch is standalone, exactly as
  every branch is today. This one column, defaulting to empty, is the entire
  backward-compatibility guarantee the whole proposal rests on.

### `organization_members` — who has cross-branch access, tagging an *existing* person

- `organization_id` → `pharmacy_organizations` — which company this
  membership belongs to.
- `user_id` → `users` — **the same, already-existing `users` table** used
  for every branch login today. This table does not create new people; it
  takes a person who already has a normal branch account and additionally
  tags them as having organization-level access.
- `role` — `org_owner` or `org_manager` (see §3 for what each can do).
- A person can hold only one role per organization (enforced by a
  uniqueness rule on the organization+person pair), but the design does not
  stop one person from being a member of more than one organization, or from
  keeping their own separate, unrelated home branch untouched by any of
  this — `users.branch_id` and `users.role` are never modified by this
  table.
- **Relationship:** one organization → many members; one existing user
  account → can appear in zero, one, or more membership rows.

### `stock_transfers` — the shipment record

- `organization_id` → `pharmacy_organizations` — both branches in the
  transfer must belong to this same company.
- `from_branch_id` and `to_branch_id` → **both point at the same existing
  `branches` table**, just playing two different roles (sender and
  receiver) in the same row. A check rule stops a branch from being listed
  as both at once.
- `requested_by` and `approved_by` → both point at the existing `users`
  table — who asked for the transfer, and who signed off on it.
- `status` → one of six fixed values (`pending`, `approved`, `in_transit`,
  `received`, `rejected`, `cancelled`) that can only move forward through
  the sequence described in §5, never backward.
- **Relationship:** one organization → many transfers; one branch can appear
  in many transfers, either as sender or receiver; one transfer → many line
  items (next table).

### `stock_transfer_items` — exactly what is inside the shipment

- `transfer_id` → `stock_transfers` — which shipment this line belongs to.
- `stock_batch_id` → **the existing `stock_batches` table** — the very same
  batch record created back when that stock was first delivered into a
  branch through the normal, already-existing delivery process. A transfer
  does not create new stock out of nowhere; it points at stock that already,
  genuinely exists somewhere, and later re-assigns which branch owns it.
- A given batch cannot appear twice in the same shipment (enforced by a
  uniqueness rule on the transfer+batch pair).
- **Relationship:** one transfer → many items; one existing stock batch →
  can be referenced by a transfer item, but a batch can only be actively
  "in" one open transfer at a time in practice (see the RPCs in the `.sql`
  file for exactly how that is enforced).

### `barcodes.status` — one new allowed value on an existing column, not a new table

Not a relationship, but worth knowing alongside the above: the existing
`barcodes` table already has a `status` column (`active`, `sold_out`,
`expired`, and so on). This proposal adds one more allowed value,
`in_transit`, so that while a box is on the road between branches — after
dispatch, before receipt — it correctly shows as not sellable anywhere,
rather than still appearing sellable at the branch it just left.

### The whole picture in one diagram

```
pharmacy_organizations (the company)
    │
    ├─▶ branches.organization_id            (one company, many branches)
    │
    ├─▶ organization_members.organization_id
    │        └─▶ user_id ──▶ users           (tags an existing person)
    │
    └─▶ stock_transfers.organization_id
             ├─▶ from_branch_id ──▶ branches
             ├─▶ to_branch_id   ──▶ branches
             ├─▶ requested_by   ──▶ users
             ├─▶ approved_by    ──▶ users
             └─▶ transfer_id (in stock_transfer_items)
                      └─▶ stock_batch_id ──▶ stock_batches (existing table)
```

The pattern to point out when explaining this to someone else: follow any
arrow down from `pharmacy_organizations` far enough, and it always lands on
a table that already existed before this proposal (`branches`, `users`,
`stock_batches`). The four new tables are connective tissue, not a second,
parallel system.

---

## 5. What actually happens, step by step, when stock moves between branches

This is the concrete workflow the tables above exist to support:

1. **Request** — Kigali Central's own manager decides to send some stock to
   Huye. They pick which batches and where to. This creates the shipment
   record, status `pending`. Nothing has moved yet.
2. **Approve** — Either Huye's own manager (agreeing to receive it) or an
   organization member (head-office sign-off) approves it. Status becomes
   `approved`.
3. **Dispatch** — Kigali Central confirms the stock has physically left the
   building (a driver picked it up). At this exact moment, that stock stops
   being sellable at Kigali Central — it is on the road, not on their shelf.
   Status becomes `in_transit`.
4. **Receive** — Huye confirms the stock has physically arrived. Only now
   does it become sellable — at Huye. Status becomes `received`.

Two safety details worth knowing: a shipment can only be rejected or
cancelled *before* it is dispatched — once it has physically left a branch,
the workflow can only end in it being received, matching how a real shipment
in transit cannot simply be "undone." And the physical barcode sticker on
every box or pack never changes during a transfer — the system just updates
which branch currently owns that same, already-printed barcode.

---

## 6. What the organization level (the "parent" concept) gets access to

| Capability | Who |
|---|---|
| See every branch's revenue, stock alerts, and pending transfers in one summary | `org_owner`, `org_manager` |
| Add a brand-new branch to the company, active immediately | `org_owner` only |
| Grant or revoke another staff member's cross-branch access | `org_owner` only |
| Approve or reject a stock transfer between any two of the company's branches | `org_owner`, `org_manager`, or the *receiving* branch's own manager |
| See every stock transfer across the whole company, not just ones involving their own branch | `org_owner`, `org_manager` |

Everything in this table is **read and oversight** access, plus the two
specific administrative actions (adding a branch, managing membership).
Nothing here lets an organization member reach into another branch's stock
room and sell from it, edit its patients, or change its receipts directly —
see §7.

---

## 7. What an individual branch gets access to — and what stays exactly the same

This is the part worth reading closely if the concern is "will this change
how my branch already works":

**Unchanged, for every branch, whether or not it ever joins an
organization:** selling at the till, receiving deliveries, adjusting stock,
registering patients, managing staff, insurance claims, reports — every
existing screen, every existing permission, works exactly as it does today.
A branch that never joins an organization will never see anything different
at all.

**New, only for a branch that has joined an organization:**

| Capability | Who at the branch |
|---|---|
| Request a stock transfer *out* to another branch in the same company | that branch's own owner or manager |
| Confirm dispatch of an outgoing transfer | that branch's own owner or manager |
| Confirm receipt of an incoming transfer | that branch's own owner or manager |
| See transfers where their own branch is either the sender or the receiver | anyone who can already see that branch's own data |

**What a branch can never do, even inside an organization:** sell a product
that physically belongs to another branch's stock room, view another
branch's patient list or staff, or adjust another branch's inventory by
remote control. The *only* way stock legitimately moves from one branch to
another is the formal transfer workflow in §5 — there is no other new door
opened between branches.

---

## 8. A worked example

Say **Kigali Pharmacy Ltd** currently runs on PharmSync as one branch,
"Kigali Central," the way every pharmacy on the platform works today. The
owner decides to open a second location in Huye.

1. The Kigali Central owner turns their existing branch into the first
   branch of a new company record, "Kigali Pharmacy Ltd" — nothing about
   Kigali Central itself changes; it simply now belongs to an organization,
   and its owner is that organization's first `org_owner`.
2. The owner adds "Huye Branch" as a second branch under the same company.
   Because the owner is already a known, verified business (unlike a
   complete stranger registering for the first time), this new branch can
   go live immediately, without the phone-verification step a brand-new
   pharmacy goes through today.
3. Someone is hired to run Huye day to day and gets a normal branch account
   there, exactly like any seller/manager account today — nothing special
   about it.
4. A month later, Kigali Central has excess stock of a slow-moving item and
   Huye is running low. Kigali Central's manager requests a transfer; Huye's
   manager approves it; Kigali Central dispatches it; Huye receives it. The
   stock is now sellable at Huye, and the whole movement is on record.
5. The owner, from either branch or from a dedicated organization view,
   can see both branches' revenue and stock health side by side at any
   time — without needing two separate logins or asking Huye's manager to
   send a report.

Nothing in this story required Kigali Central's day-to-day staff — the
cashier, the pharmacist — to learn anything new. The only new capability
they might ever touch is requesting or receiving a transfer, and only if
their branch is actually part of a multi-branch company.

---

## 9. Why "organization" is modeled the way Rwanda's own tax system already works

This is not a generic pattern borrowed from elsewhere — it deliberately
mirrors how RRA's own EBM/VSDC e-invoicing system already works: **one TIN
(the company) with several registered branch codes underneath it**, each
branch invoicing on its own but consolidating up to a single legal entity.
`pharmacy_organizations.tin` is meant to become that one company-level TIN,
the same way `branches.tin` today represents a standalone pharmacy's own
TIN. The exact numbering RRA expects for a branch code under a company TIN
still needs confirming before this ships — see the open questions in the
`.sql` file — but the *shape* of the design (one TIN, many branches) already
matches Rwanda's real regulatory structure rather than inventing a new one.

---

## 10. What this proposal deliberately does not include yet

Kept out of this first version on purpose, not overlooked — each is
explained further in Section 6 of the `.sql` file:

- **Recognizing the same patient across two branches of the same chain.**
  Today, and after this proposal, a patient seen at both Kigali Central and
  Huye is still two separate, unconnected records.
- **Splitting one batch of stock across two branches in a single transfer.**
  A transfer always moves a whole batch — the reasoning is that splitting it
  would mean the physical barcode sticker on a moved box could stop matching
  what the system says about it.
- **Any change to pricing or billing for a multi-branch company.** That is a
  business decision, not something this schema proposal decides.

---

## 11. Where to go for more detail

- **Full technical design, every table/column/function, and eight open
  questions that need a decision before this is approved:**
  `PROPOSAL_multi_branch_organizations.sql`
- **Visual diagram of every table in the system, existing and new, and how
  they connect:** `PROPOSAL_multi_branch_organizations.eraser`
