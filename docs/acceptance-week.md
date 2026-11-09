# Acceptance week — record

Procedure: [`docs/verification.md`](verification.md) §6 · Ticket:
[#86](https://github.com/roninlp/tali/issues/86)

Fill this in during the week; do not reconstruct it afterwards. The point is
evidence that both users planned, tracked, and reviewed a full week in Tali,
not a summary written from memory.

## Run header

| Field | Value |
| --- | --- |
| Stage / URL | |
| Commit under test | |
| Week (Jalali) | |
| Week (Gregorian) | |
| Users | |
| Devices (model, OS, browser, installed PWA?) | |
| Nightly `gate-flows` run | |
| Accessibility pass | green / red (link) |

## Daily log

One row per user per day. `✓` done, `✗` failed, `—` not attempted (say why).
Link an issue for every `✗`.

| Day | User | Morning plan | Through the day | Offline moment | Evening review | Issues opened |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A | | | | | |
| 1 | B | | | | | |
| 2 | A | | | | | |
| 2 | B | | | | | |
| 3 | A | | | | | |
| 3 | B | | | | | |
| 4 | A | | | | | |
| 4 | B | | | | | |
| 5 | A | | | | | |
| 5 | B | | | | | |
| 6 | A | | | | | |
| 6 | B | | | | | |
| 7 | A | | | | | |
| 7 | B | | | | | |

Notes per day (what broke, what felt wrong, what you worked around):

- Day 1 —
- Day 2 —
- Day 3 —
- Day 4 —
- Day 5 —
- Day 6 —
- Day 7 —

## Must acceptance metrics

Targets from `docs/must-have-feature-map.html` §10; procedure in
[`docs/verification.md`](verification.md) §5.

| Metric | Target | Measured | Verdict |
| --- | --- | --- | --- |
| Quick add (task / note / habit) | < 10 s each, one hand | | |
| First full load | < 2 s | | |
| Interaction latency (complete, check, log) | < 100 ms | | |
| `/today` server response | p50 < 150 ms warm (P0) | | |
| Offline core (task, note, list, habit) | writes survive, sync on reconnect | | |
| Shared list live sync | visible to the other user within a few seconds | | |
| Medication reminder | ≥ 90 % on-time responses | | |
| Missed reminders in inbox | every unanswered one appears | | |
| Data loss | zero unintended | | |
| Trash restore | restored row intact | | |
| Backup restored drill | `docs/backup-restore.md` drill passes | | |
| Accessibility | WCAG 2.1 A/AA gate green; manual checks pass | | |
| RTL / 320 px | no horizontal scroll, icons mirrored | | |

## Findings

| Issue | Severity (blocker / known-fix) | Status | Notes |
| --- | --- | --- | --- |
| | | | |

## Sign-off

- [ ] All 14 user-days recorded, four steps each.
- [ ] Zero open blockers.
- [ ] Metrics meet targets, or each miss has a written, accepted reason.
- [ ] Known-fixes filed as issues and listed above.
- [ ] This file committed and linked from
      [#86](https://github.com/roninlp/tali/issues/86).

Signed off by: ______________________ Date: __________
