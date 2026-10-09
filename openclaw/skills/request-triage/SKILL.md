---
name: request-triage
description: Decide what a request for new or changed work needs before anything is built. Use it before you create a skill, a workflow or an integration, and for any request to change this system; not for a question about the design documents or a plain edit of the project repository. It answers with one of three outcomes and an estimate that has reasons.
---

# Request triage

A person asks for something to be done, built or changed. Decide what it
needs before you start, and say so in the format below. You decide; you do not
build a new capability here.

## The three outcomes

1. **Do it now.** The capabilities listed below are enough: a search of the
   design documents, reading or changing the project repository with the
   coding tools, running commands there. Do the work, using the matching
   skill, and report it.
2. **Compose.** The capabilities are enough, but nothing ties them together
   yet. Propose a skill or a workflow: its steps, the tools each step uses,
   and where a person must approve. No change to the base code is needed.
   Propose it in your answer; do not create its files here, a person decides
   that.
3. **New capability.** Something is missing: a new kind of input or output
   (mail, a ledger file, another system), a new permission, or a kind of data
   that is not in the cache. Do not build it and do not start. Say what is
   missing and why the capabilities below do not cover it.

## What exists now

Refresh this list when a skill is added.

- Search the design documents (the local knowledge cache, read only) and cite
  the source: the `knowledge-search` skill.
- Read and change the files of the project repository; run commands in it.
- Write a local draft of an implementation issue for a capability that is
  missing, into the `drafts` folder of your workspace, for a person to read:
  the `issue-draft` skill. It publishes nothing.
- Nothing else: no web, no mail, no writing to a ledger or another system, no
  messages to other people, no other machine. The public web is reached by a
  separate instance, whose findings a person carries over.

## The estimate

Judge four things, and give a size with the reasons, not a bare number:

- **Reuse:** does every step use something that exists? (all, some, none)
- **New input or output:** a source or a destination that does not exist yet.
  (none, one, several)
- **Permissions:** what must be allowed that is not allowed now. (none, read,
  write, send)
- **Testing:** what it takes to test it. (plain assertions, fixtures, a real
  external system)

Size **S**: everything is reused, no new input or output, no new permission.
Size **M**: one new input or output, or a new read permission, and fixtures
are enough for tests. Size **L**: several new inputs or outputs, a write or
send permission, or tests that need a real external system.
Outcome 3 with size M or L is not small: it goes to an implementation issue.
The `issue-draft` skill can write the draft locally; a person reviews it and
publishes it.

## Answer in this form

```text
Outcome: <1, 2 or 3> (<do it now | compose | new capability>)
Why: <the reasons, one or two sentences>
Reused: <what exists and is used>
New input or output: <none, or what>
Permissions: <none, read, write or send, and for what>
Testing: <how it would be tested>
Estimate: <S, M or L>
Next step: <what to do now, or what a person has to do>
```

## Boundaries

- Never send the request, any of its details or anything from the cache out
  of this session: no web search, no message, no upload. Your answer stays
  here, and a person decides what leaves.
- Do not publish an issue. If the outcome is 3, say that a person has to turn
  it into an issue; when the person wants the text of it, the `issue-draft`
  skill writes a draft, locally, for a person to read first.
- Answer in the language of the request.
