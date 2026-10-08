---
name: knowledge-search
description: Look up the project's design documents (Excel specifications and memos) in the local knowledge cache and cite where each fact comes from. Use it before answering or coding anything that depends on requirements, screens, table definitions, batch jobs or other design decisions.
metadata: { "openclaw": { "requires": { "bins": ["pnpm"] } } }
---

# Knowledge search

The design documents of this project were converted from Excel workbooks and
indexed on this machine. Search that index instead of guessing, and say where
each fact comes from.

## Search

Call the `exec` tool with these parameters. The question travels in `env`,
never in the command, so quotes, `$(...)` or backticks in it cannot change what
runs:

- `command`: `pnpm run --silent kc:search --json --k 5 --question-env KC_QUESTION`
- `workdir` and `env`:

  ```json
  {
    "workdir": "{{KC_REPO}}",
    "env": {
      "KC_QUESTION": "<the question>",
      "KC_DATA_DIR": "{{KC_DATA}}",
      "OLLAMA_HOST": "{{KC_OLLAMA}}"
    }
  }
  ```

Never put the question on the command line: it would pass through a shell, and
it would show up in process lists and command logs. If the `exec` tool you have
cannot set `env`, do not search; tell the user that the knowledge cache cannot
be queried safely with this tool.

- Write the question in the language of the documents (usually Japanese) and
  include concrete identifiers when you have them: screen IDs, table or column
  names, batch names.
- The output is a JSON array. Every hit has `rank`, `score` (cosine
  similarity, higher is closer), `path` (the workbook or memo), `sheet`,
  `refs` (cell ranges such as `画面一覧!A3:D6`) and `text` (the passage).
- Narrow a search with `--path <folder-prefix>` or `--sheet <sheet name>`.
- Search again with different words or identifiers when the first result is
  weak. Several short queries beat one long one.

## Answer

- Use only what the hits say. Quote or paraphrase the passage and cite it as
  `path (refs)`, for example `設計/基本設計書.xlsx (画面一覧!A3:D6)`.
- Scores depend on the embedding model, so judge relevance by reading the
  passage, not by the number alone. A low score with an off-topic passage, or
  an empty result, means the cache has nothing relevant. Say so plainly and do
  not invent a specification.
- If hits disagree, report the disagreement and cite both.
- If the cache looks out of date, tell the user to run
  `pnpm run ingest --source <share>` on the host; you cannot do it yourself.

## Boundaries

This instance has no web access, and what the cache returns comes from
internal documents. Keep it on this machine: never paste it into anything that
leaves it, such as a request to another service.
