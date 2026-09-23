---
name: kickoff-plan
description: 13:00 routine — turn the published track task into docs/PLAN.md with scored scenario options, then a 4-hour cut plan. Use once, right after the task text is pasted.
---

# /kickoff-plan

Input: the full task text of Track 05 pasted by the user. Output: docs/PLAN.md filled and committed, within 20 minutes.

1. Read the task 3 times. Extract verbatim: required deliverables, mandatory technologies/data, scoring criteria with points, submission format. Put them in PLAN.md section «Задание трека».
2. Build the criteria table: for each scoring criterion — points, what exactly we will do to earn it, which file/endpoint will prove it.
3. Read docs/SCORING.md and docs/IDEAS.md. Propose exactly 3 candidate scenarios. For each: target user (concrete person), one-sentence value, agent tools needed (2–4), data source (must be obtainable in <20 min: open data, synthetic, or bundled sample), estimated score against the criteria table, persona + pain in numbers + before/after metric + innovation mechanism (all four are mandatory per SCORING.md), biggest risk. Prefer scenarios where the agent visibly uses tools and data, not a chat wrapper.
4. Recommend one. State why it maximizes points in 5 hours and why it beats «просто ChatGPT».
5. Write the hourly cut plan with what must be demoable at 14:00, 15:00, 16:00, 17:00 and what gets dropped first if behind.
6. Write the main scenario as 3–5 user steps into README section 8 (draft) and section 1 «Что реализовано» as unchecked boxes.
7. Commit: `docs: plan for track task` and push. Then start building the 14:00 skeleton immediately.
