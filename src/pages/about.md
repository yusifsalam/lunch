---
layout: "@/layouts/MarkdownLayout.astro"
title: About
---

# How this works

This app helps your group decide where to eat lunch. Every weekday there's a
**lunch train** — join it, help pick a place, and go eat together.

## Logging in

There are no accounts. You log in with a **passcode** and whatever
**display name** you want to appear as. There are two passcodes: the
regular one makes you a member, the admin one makes you an admin. Your
identity lives in a cookie, so logging in again (even with a different
name) is cheap and harmless.

## Trains

- A **default train** appears automatically every weekday. Anyone can also
  start extra **named trains** the same day ("12:00 crew", "sushi gang").
- You ride **at most one train per day**. Joining another train — or voting
  in one — moves you there, vote and all.
- Every train has a **join deadline** (12:15 by default, adjustable by the
  train's manager). It doesn't lock anything: after the train "departs" you
  can still hop on, you'll just get a warning that you're late.
- On weekends new trains are admin-only — but once one exists, anyone can
  join in.
- Joining and leaving stay open even after the decision is made; only the
  decision itself locks.

## Deciding

Each train picks its destination in one of three modes:

- **🗳️ Democracy** — everyone votes for a place (one vote each, changeable
  until the train is finalized). Most votes wins; ties are broken randomly.
  Voting automatically joins you to the train.
- **👑 Dictatorship** — a designated dictator picks the place for everyone.
- **🎲 Random** — the app draws a random place from the list.

Switching modes is reversible: votes and the chosen dictator are kept, so
you can flip to random and back without losing anything. When the train is
**finalized**, the outcome is fixed and voting locks. A manager can
**reopen** it — votes and participants are kept, so finalizing again
re-tallies.

A train is **managed** — mode, dictator, deadline, finalize, reopen,
delete — by whoever created it, plus the group's admins. The automatic
default train has no creator, so it's admin-managed.

## Places

The place list is a **shared, curated list** — everyone can add to it. A
place can carry:

- **Menus and prices.** Prices keep a history: recording the same price
  again does nothing, so the history shows only actual changes.
- **Ratings** (half-star precision). You can only rate a place you've
  actually eaten at — meaning you rode a finalized train that ended up
  there. Ratings keep a history too; your newest rating counts.
- **Opening hours**, with an optional **lunch window** per day. A place
  closed today — or one that doesn't serve lunch today — is automatically
  left out of voting and random draws. Temporary **closures** (holidays,
  renovations) do the same for a date range.

A place that has ever been a train's final destination can't be deleted —
it's part of history. It can be **archived** instead, which hides it from
future votes but keeps it in past sessions (and it stays rateable).
