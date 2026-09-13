# Personal Observatory

Personal Observatory collects evidence about AI activity and account capacity so one person can understand usage without treating unlike measurements as interchangeable.

## Usage language

**Usage account**:
A provider identity, subscription, or organization that owns usage facts and allowance meters.
_Avoid_: Connection, machine

**Execution activity**:
Observed model work associated with a conversation, including its token quantities and any supported project, agent, or tool detail.
_Avoid_: Allowance usage, spend

**Model call**:
One model response for which the source reports usage evidence, including an explicit zero-usage response. A streaming response, its updates, and its final usage record are one model call.
_Avoid_: Request, API call

**Successful model call**:
A model call whose source explicitly records successful completion. Lack of an observed error does not establish success.
_Avoid_: Model call, aggregate request

**Aggregate request count**:
A provider-reported request total without stable request identities. It can support an aggregate headline but does not create observed model calls or conversations.
_Avoid_: Model calls, conversations

**Conversation**:
One distinct root provider session or thread containing at least one selected canonical model call. Child-agent sessions roll up to their root conversation.
_Avoid_: Project, task

**Token composition**:
The mutually exclusive fresh input, cached input, cache-write input, output, and unclassified quantities that reconcile to observed total tokens. Reasoning tokens are a subset of output tokens.
_Avoid_: Context composition

**Tool invocation**:
One distinct model-issued protocol instruction to execute a tool. Its result, progress messages, ingestion retries, and operations hidden inside a wrapper are not additional invocations unless the model separately issued them with their own identities.
_Avoid_: Tool result, model call

**Successful tool invocation**:
A tool invocation whose source explicitly records successful completion.
_Avoid_: Reported tool invocation

**Agent spawn**:
One observed attempt to create a child agent.
_Avoid_: Subagent

**Observed subagent**:
A distinct child agent identity supported by child-side or lifecycle evidence. Resuming the same child does not create another observed subagent.
_Avoid_: Agent spawn, model call

**Project**:
A user-named body of work to which one or more native project identities, working directories, or worktrees can be mapped.
_Avoid_: Folder, repository

**Unassigned project**:
Activity with a stable native project or local path identity that has not been mapped to a named Project.
_Avoid_: Unknown project, No project

**Knowledge source**:
A named collection of reference material, such as an Obsidian vault, whose access can be recognized from configured local roots or connector identities.
_Avoid_: Tool, project

**Knowledge access**:
An observed tool invocation whose recorded resource identity or supported argument resolves against the versioned knowledge-source configuration active for that event. Working context can resolve a relative argument but does not prove access by itself.
_Avoid_: Knowledge use

**Allowance window**:
One provider-reported capacity meter for an account, scope, duration, and reset boundary.
_Avoid_: Token budget

**Burn rate**:
The observed or forecast change in an allowance meter over time, expressed in that meter's unit; percentage allowances use percentage points per hour or day.
_Avoid_: Token velocity

**API-equivalent estimate**:
The hypothetical API price of observed execution activity under a named pricing catalog and assumptions.
_Avoid_: Spend, bill, subscription cost

**Environmental scenario estimate**:
A modeled electricity, direct-water, or operational-carbon quantity for observed execution activity under a named methodology and scenario.
_Avoid_: Measured footprint, offset

**Coverage slice**:
The smallest logical account, provider/product population, execution identity, half-open time interval, model, and native-dimension scope for which collection can state whether its facts are complete. Collector identity is provenance unless it proves a distinct execution population.
_Avoid_: Receipt, freshness

**Unknown**:
A fact that the source did not establish.
_Avoid_: Zero, none

**No project**:
Activity for which the source affirmatively reports that no project applies.
_Avoid_: Unknown project

**Unattributed**:
A measured quantity that cannot be assigned to the selected dimension without inference.
_Avoid_: Missing usage
