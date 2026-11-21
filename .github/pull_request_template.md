<!--
Write the title and opening problem statement for people connecting to a remote desktop.
Name the affected task and the symptom or outcome, not only the implementation.
Good: fix: explain why a remote desktop connection did not start
Bad: fix: update the relay error mapping
For internal-only work, name the actual developer or operator workflow affected;
do not invent an end-user benefit.
-->

<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line
below this comment.

Required PR title:
type: user-facing description
Use a parenthesized scope only when it adds clarity:
fix(auth): login redirect loops when session cookie is expired

Types: feat, fix, refactor, build, ci, chore, docs, style, perf, test.
For fixes, describe the user-visible symptom and trigger:
fix: desktop list fails to load when no computers are registered
Avoid implementation details such as:
fix: add null check to desktop query

**MUST:** Keep **Allow edits from maintainers** enabled for this PR so maintainers
can help update the branch when needed.
-->

## What Problem This Solves

<!--
In 1-3 plain-language sentences, explain the affected task, what fails or is
missing, and why it matters. Include the trigger when known. Do not invent a bug
for other changes. These examples illustrate wording, not an observed defect:
Good: "People connecting to a remote desktop cannot tell why the connection did not
start, so they do not know which recovery action to take."
Bad: "Updates an internal handler and adds a missing check."
-->

<!--
Describe the concrete user, product, or operational problem.
In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."
-->

## User Impact

<!--
"User impact: <what users, operators, or developers can now do or expect>."
Lead with the concrete outcome in plain language, usually one sentence.
For internal-only changes, say there is no user-visible change; do not invent a benefit.
Keep important risks, breaking changes, migrations, and required user actions visible here.
-->

## Why This Change Was Made

<!--
Briefly explain how the change addresses the problem without repeating the impact.
Keep the body short. Leave file lists, internal acronyms, and root-cause walkthroughs
in the diff or optional <details>; include technical detail only when it explains
behavior or a material tradeoff. Do not hide risks or required actions in <details>.
-->

## Evidence

<!--
Lead with the behavior checked and the observed result in plain language, then
include exact commands and supporting evidence. Put long logs and commit hashes
in links or optional <details>. Keep meaningful gaps, risks, and required
actions visible; do not make readers decode commands to learn what was verified.
-->

<!--
Show the most useful proof that this change works. Screenshots, screencasts,
terminal output, focused tests, CI results, live observations, redacted logs,
and artifact links are all useful. Include before/after evidence for visual
changes when it clarifies the result.

Reviewers will inspect the code, tests, and CI. Use this section to make the
validation easy to understand, not to restate the diff.
Summarize what was checked and the result; note meaningful gaps. Link long output
or put it in optional <details>, keeping the useful evidence summary visible.
-->
