-- USG-035: the git branch a request's transcript recorded, sent only when
-- `execution.branch_attribution` is `plain` (companion 2.3.0). Both columns stay
-- NULL on every earlier row and whenever the setting is off; a row that carries a
-- basis names the branch exactly when the transcript recorded one.
ALTER TABLE personal_hub.activity_requests
  ADD COLUMN git_branch text,
  ADD COLUMN git_branch_basis text,
  ADD CONSTRAINT activity_requests_git_branch_basis_check
    CHECK (git_branch_basis IS NULL OR git_branch_basis IN ('recorded','detached','unknown')),
  ADD CONSTRAINT activity_requests_git_branch_presence_check
    CHECK ((git_branch IS NOT NULL) = (git_branch_basis IS NOT DISTINCT FROM 'recorded'));
