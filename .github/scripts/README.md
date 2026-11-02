# Issue priority automation

`Issue Triage Labels` keeps three independent sources of priority:

- `user-priority/P0`–`P3`: the reporter's requested urgency, handled by the existing label script.
- `ai-priority/P0`–`P3`: an AI suggestion for repair/implementation order based on the reported impact, scope, regressions and workarounds.
- Maintainer labels such as `P0` or `P3`: human decisions; the AI never modifies them and they take precedence.

AI suggestions are not verified diagnoses, proof that an issue is valid, or release commitments. The model sees only bounded issue title/body text and database/type labels, not source code, comments, linked pages or screenshot contents. It cannot establish actual production-wide impact. Priority fields and user-priority labels are excluded from its input to avoid copying the reporter's selection.

## Rubric

| AI label | Repair / implementation priority |
| --- | --- |
| `ai-priority/P0` | Critical security exposure, irreversible persistent data loss/corruption caused by normal DBX operations, or widespread core failure without a viable workaround; concrete evidence and high confidence required. Destructive defects are not downgraded solely because few users or one engine are currently affected, or because backups exist. Immediate maintainer review. |
| `ai-priority/P1` | Major non-destructive core workflow blocked, significant regression, serious recoverable risk, or a missing capability demonstrably blocking a common core workflow; P0 conditions take precedence. |
| `ai-priority/P2` | Meaningful functional bug or useful feature with limited impact or a practical workaround. |
| `ai-priority/P3` | Cosmetic issues, minor convenience, optional polish or narrowly useful low-impact enhancements. |
| `ai-priority/needs-info` | Insufficient evidence, low confidence or an unsupported critical-priority assessment; not a default P2. |

Bug severity alone is not feature priority: a broadly blocking missing capability may outrank a minor bug. Requested deadlines and urgency do not determine either. The response must cite exact title/body evidence; invalid or invented evidence is rejected. The rationale, confidence, evidence, missing information and model are recorded in the Actions step summary, without posting issue comments.

## Configuration

1. Set the repository Actions secret `ATLASCLOUD_API_KEY`. Never commit credentials.
2. Optionally set the repository variable `ISSUE_TRIAGE_MODEL`. The default is `deepseek-ai/deepseek-v3.2`.
3. Deploy the workflow and script on the default branch. Existing `workflow_dispatch` and database-label synchronization behavior is unchanged; no historical-issue backfill is performed.

The integration uses AtlasCloud's `https://api.atlascloud.ai/v1/chat/completions` endpoint, Bearer authentication, non-streaming Chat Completions and JSON mode. The default model ID and JSON-mode capability were checked against `/v1/models` on 2026-09-17. A replacement model must support the same request/response format. See `https://www.atlascloud.ai/docs/zh/models/llm` for the provider's integration documentation.

New and reopened open issues are evaluated, as are title/body edits. This includes changes solely to the user-priority field: that field is still excluded from the model input, but skipping the replacement run could lose an assessment if the preceding workflow was canceled by concurrency. Input is capped to a 500-character title and 14,000 body characters (start and end retained), with up to 1,500 output tokens and a 60-second request timeout. There are no automatic retries. Each eligible event can incur a paid provider call, and bounded public issue text is sent to AtlasCloud.

Maintainers can create and apply `ai-priority/skip` to opt an issue out; existing AI labels are then left untouched. Editing comments alone does not trigger this workflow, so important clarification should also be added to the issue body.

Missing credentials skip AI with a warning. Provider/authentication/timeout/invalid-output failures occur before any label writes and preserve previous classifications. The AI step is non-blocking and does not prevent the existing database/title/user-priority flow from succeeding. Before writing, the script rechecks that the issue remains open, is not opted out and its assessment input has not changed. A new AI label is added before obsolete AI priority labels are removed; a GitHub write failure may require a later eligible event to reconcile them. No other label namespaces, assignees, issue states or comments are modified.

## Validation

```sh
node --test .github/scripts/ai-issue-priority.test.mjs .github/scripts/label-issue-database.test.mjs
node --test .github/scripts/*.test.mjs
```

For a read-only end-to-end check, supply the usual Actions event/token variables and set `DRY_RUN=1`. This still calls AtlasCloud and reads the issue from GitHub, but makes no GitHub writes. Never print the environment or include a real key in fixtures, command arguments or logs.
