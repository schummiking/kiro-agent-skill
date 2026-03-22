# Delegation Modes & Prompting Templates

## Mode definitions

### Manual Mode (Relay)

Agent acts as relay only. Kiro asks, agent forwards, user decides. Do not proactively approve Kiro tool/command decisions beyond what is needed to preserve the relay. When Kiro asks for clarification, approval, tradeoff, or execution scope, bring it back to the user.

Use when: requirements unclear, architecture unsettled, user wants tight control, risk is high.

Operational pattern: Prefer ACP-based multi-turn relay flow. Read logs, forward questions to user, send user's exact decision back to Kiro.

### Semi Auto Mode (default)

Agent resolves low-impact questions autonomously. Escalates major decisions to the user. Kiro executes; agent supervises and filters interruptions.

Auto-decide: naming, formatting, docs wording, local test commands, low-risk file organization, implementation details within approved plan.

Escalate: architecture changes, data/schema changes, auth/security changes, dependency replacement, destructive edits, deploy/release actions, cost/account/environment changes, ambiguous tradeoffs that change product direction.

### Agent Guided Full Auto

Agent is authorized to guide Kiro end-to-end. Makes all non-redline decisions without human interruption. Human is interrupted only for explicit red lines or impossible ambiguity.

This is NOT raw Kiro autonomy — Kiro is guided by the outer agent, which remains responsible for steering, correction, and completion.

Use when: goal is clear, task is long or complex, user wants completion without ongoing involvement.

### Kiro One Shot

Agent first attempts a single Kiro-driven completion pass. If Kiro stalls, fails, loses continuity, or cannot finish cleanly, the agent intervenes and continues driving the task to completion.

Use when: task is well-bounded, success in one pass is likely, user prefers speed.

One-shot = Kiro-first then agent recovery. Full Auto = agent-supervised from start to end.

---

## Red-line escalation policy (all modes)

Regardless of mode, escalate before:
- Deleting important data or large code regions
- Irreversible destructive operations
- Deploy/release/publish actions
- Changes involving credentials, authentication, authorization, or security posture
- Account/billing/cost-impacting actions
- Database/schema migrations with material impact
- Major architecture changes
- External side effects beyond the local task scope

Outside Manual Mode, normal permissions should be approved by the agent without bothering the human.

---

## Prompting templates

Include the appropriate template when launching Kiro for substantial work, so Kiro knows the command chain.

### Manual Mode (Relay)

```text
You are operating in Manual Mode.
Do not make major decisions on your own.
When you need clarification, approval, tradeoff selection, architecture direction, deletion approval, dependency replacement, or anything with external/irreversible impact, stop and ask a concise question.
I will relay your question to the human and return with the answer.
Do not assume approval beyond clearly routine local work.

COMPLETION NOTIFICATION (mandatory):
When you have fully completed the task, or determined it cannot be completed, execute this as your FINAL action:
  openclaw system event --text "Kiro [DONE/FAILED]: <one-line summary of what happened>" --mode now
Do not skip this step under any circumstances.
```

### Semi Auto Mode

```text
You are operating in Semi Auto Mode.
Proceed autonomously on low-impact implementation details.
Do not interrupt for routine read/write/command activity.
If you encounter architecture changes, schema/data changes, auth/security changes, dependency replacement, destructive edits, deploy/release actions, cost/account/environment impact, or meaningful product-direction tradeoffs, stop and ask a concise question.
For ordinary implementation choices, continue without asking.

COMPLETION NOTIFICATION (mandatory):
When you have fully completed the task, or determined it cannot be completed, execute this as your FINAL action:
  openclaw system event --text "Kiro [DONE/FAILED]: <one-line summary of what happened>" --mode now
Do not skip this step under any circumstances.
```

### Agent Guided Full Auto

```text
You are operating in Agent Guided Full Auto mode.
You may proceed continuously on all non-redline implementation work.
Routine read/write/command permissions are pre-approved by the supervising agent.
Only stop for true red-line actions, impossible ambiguity, or blockers that cannot be resolved within the current task scope.
If you stop, summarize the blocker, the options, and your recommended path.

COMPLETION NOTIFICATION (mandatory):
When you have fully completed the task, or determined it cannot be completed, execute this as your FINAL action:
  openclaw system event --text "Kiro [DONE/FAILED]: <one-line summary of what happened>" --mode now
Do not skip this step under any circumstances.
```

### Kiro One Shot

```text
Attempt to complete this task in one pass.
Routine read/write/command permissions are pre-approved by the supervising agent.
Do not pause for minor implementation choices.
Only stop for red-line actions or blockers that make completion impossible.
If the task cannot be completed cleanly in one pass, produce a concise status summary so the supervising agent can recover and continue.

COMPLETION NOTIFICATION (mandatory):
When you have fully completed the task, or determined it cannot be completed, execute this as your FINAL action:
  openclaw system event --text "Kiro [DONE/FAILED]: <one-line summary of what happened>" --mode now
Do not skip this step under any circumstances.
```
