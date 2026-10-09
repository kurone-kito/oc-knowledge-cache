---
name: issue-draft
description: Write the text of an implementation issue for a capability that this system lacks, as a local draft that a person reads before anything is published. Use it after request-triage says "new capability", or when a person asks for an issue draft. It writes files here and publishes nothing.
---

# Issue draft

A capability is missing and a person wants it built elsewhere, by someone who
has never seen this project. You write the text of the issue. You do **not**
publish it, send it, or paste it anywhere: it stays in a file on this machine
until a person has read it and decided what leaves.

## Never

- Publish, send or upload anything. Do not run `gh`, `curl`, a mail command or
  any other command that sends text out, and do not put the draft into a web
  search.
- Make a network request of any kind, with a shell command (`wget`, a script)
  or with a tool. Nothing in this job needs the network.
- Put into the draft anything from the design documents, the cache or the
  project: no names of customers, people, systems, hosts, documents, sheets or
  tables; no paths; no quotes or excerpts; no real figures. The one number
  that may appear is the public issue of the `Part of` line. A draft that names
  the others is wrong, even if the person asked for the issue in those terms.

## Steps

1. **Generalize first.** Reduce the request to the capability that any similar
   organization would need, in generic words ("a review ledger kept as a
   spreadsheet", "an internal mail system", "a git server without pull
   requests"). Invent plain example data when an example helps.
2. **Write the draft** into your workspace, never into the project repository
   or the cache. Your working directory can be the project repository, so use
   the full path of this block and never a relative path:

   ```json
   { "drafts": "{{KC_WORKSPACE}}/drafts" }
   ```

   Create that folder when it is missing, and name the file
   `<short-kebab-name>.md` in it.
   Invent every example from scratch. Never derive one from the request: not
   an address built from a person's name (`alice.tanaka@...` from "Alice
   Tanaka"), not a file name with its version dropped, not a sheet name.
   Use plain generic words instead ("the ledger file", "the design
   document", "the reviewer").
3. **Check the draft against the request** before you go on. For every proper
   noun, person, company, host, file, sheet, path, address and document title
   in the request, make sure that none of them appears in the draft, in any
   spelling: not with another case, with hyphens, with a version removed, or
   translated. Replace what you find with a generic word and check again.
4. **Write the private note** next to it, in the same folder, as
   `<short-kebab-name>.private.md`: a list of what you generalized or left
   out (the names, documents and details of the original request). It is for
   the person who reviews the draft and is never to be published.
5. **Tell the person** the two paths, and that the draft has to be read
   against their original request, with the note beside it, before anything is
   published, because a detail of the request can still be left in it. Say
   nothing else about publishing.

## The draft

Start the file with this line and nothing before it:

```text
DRAFT - not reviewed - do not publish before a person has read it
```

Then, in English unless the person asks for another language:

```text
Part of <a public issue of this project, e.g. #34; leave this line out unless
the person named one>

## Goal
<the generic capability, in two or three sentences>

## Scope
<what to build, as a short list; what is out of scope>

## Acceptance criteria
- [ ] <checkable statements, with invented example data where needed>

## Test strategy
<what to test and with what kind of fixtures or fake services>

## Estimate
<S, M or L, and the reasons: what is reused, the new inputs and outputs, the
permissions, how it is tested; take them from the triage when there is one>

## Abstraction check
<one sentence: what the draft deliberately does not say>
```

## Boundaries

- The abstraction check is yours to do, and it is not enough on its own: a
  person reads the draft and the note before it leaves. Say so.
- The `Part of` line takes only a public issue of this project that the person
  named. Never copy another identifier from the request into it: not a ticket
  of an internal tracker, not an address of an internal system.
- Answer the person in their language; the draft is in English unless they ask
  for another language.
