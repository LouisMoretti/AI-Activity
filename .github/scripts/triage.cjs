// Shared by .github/workflows/triage.yml (actions/github-script).
// The "Linked issue" verdict is a commit status on the PR's head commit, not
// the job's result, so a label change on the issue can update it too.

const AREAS = ["ui", "server", "collectors", "infra", "security", "documentation", "accessibility"];
// Labels worth carrying over from an issue; triage labels stay on the issue.
const COPY = ["bug", "enhancement", "documentation", "accessibility", "ui", "server", "collectors", "infra", "security"];
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;
const STATUS = "Linked issue";

// Areas picked in an issue form, which renders a dropdown as "### Area\n\nui, server".
function pickedAreas(body) {
  const match = /^### Area\s*\n+([^\n]+)/m.exec(body ?? "");
  return (match?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => AREAS.includes(s));
}

function linkedIssues(body) {
  return [...new Set([...(body ?? "").matchAll(CLOSES)].map((m) => Number(m[1])))];
}

// The verdict for one PR: {ok, message, labels}.
async function verdict(github, repo, pr) {
  if (pr.labels.some((l) => l.name === "no issue")) {
    return { ok: true, message: "\"no issue\" label: no linked issue required.", labels: [] };
  }
  const refs = linkedIssues(pr.body);
  if (refs.length === 0) {
    return { ok: false, message: "Open an issue, then put \"Closes #<issue>\" in the description (or label a small fix \"no issue\")." };
  }
  const labels = new Set();
  for (const number of refs) {
    let issue;
    try {
      ({ data: issue } = await github.rest.issues.get({ ...repo, issue_number: number }));
    } catch (error) {
      if (error.status === 404 || error.status === 410) {
        return { ok: false, message: `#${number} does not exist in this repository.` };
      }
      throw error;
    }
    if (issue.pull_request) return { ok: false, message: `#${number} is a pull request; reference an issue.` };
    for (const l of issue.labels) if (COPY.includes(l.name)) labels.add(l.name);
  }
  if (labels.size === 0) {
    return { ok: false, message: `Label ${refs.map((n) => "#" + n).join(", ")} with a type and an area; this check then updates.` };
  }
  return { ok: true, message: `Closes ${refs.map((n) => "#" + n).join(", ")}.`, labels: [...labels] };
}

// Checks one PR: sets the "Linked issue" status and copies the issue's labels.
async function checkPr({ github, context, core }, pr) {
  const repo = context.repo;
  const result = await verdict(github, repo, pr);
  const has = new Set(pr.labels.map((l) => l.name));
  const missing = (result.labels ?? []).filter((name) => !has.has(name));
  if (missing.length) {
    await github.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: missing });
  }
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha: pr.head.sha,
    state: result.ok ? "success" : "failure",
    context: STATUS,
    description: result.message.slice(0, 140),
    target_url: `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
  });
  (result.ok ? core.info : core.warning)(`#${pr.number}: ${result.message}`);
}

async function onPullRequest(ctx) {
  await checkPr(ctx, ctx.context.payload.pull_request);
}

async function onIssue(ctx) {
  const { github, context, core } = ctx;
  const { action, issue, changes } = context.payload;

  // Areas: added when the issue is opened, and on an edit only those newly
  // picked, so an area label removed by hand does not come back.
  if (action === "opened" || (action === "edited" && changes?.body)) {
    const before = action === "opened" ? [] : pickedAreas(changes.body.from);
    const has = new Set(issue.labels.map((l) => l.name));
    const missing = pickedAreas(issue.body).filter((name) => !before.includes(name) && !has.has(name));
    if (missing.length) {
      await github.rest.issues.addLabels({ ...context.repo, issue_number: issue.number, labels: missing });
    }
    if (action === "opened" && has.size === 0 && missing.length === 0) {
      await github.rest.issues.createComment({
        ...context.repo,
        issue_number: issue.number,
        body: "This issue has no labels. Please add a type (`bug`, `enhancement`, `question`) and at least one area (" +
          AREAS.map((a) => "`" + a + "`").join(", ") + "). A pull request can only close a labeled issue.",
      });
    }
  }

  // The issue's labels may have changed: re-check the open PRs that close it.
  const prs = await github.paginate(github.rest.pulls.list, { ...context.repo, state: "open", per_page: 100 });
  for (const pr of prs) {
    if (linkedIssues(pr.body).includes(issue.number)) await checkPr(ctx, pr);
  }
  core.info(`#${issue.number}: triaged.`);
}

module.exports = { onPullRequest, onIssue, pickedAreas, linkedIssues };
