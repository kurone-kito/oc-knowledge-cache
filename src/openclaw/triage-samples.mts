/**
 * Sample requests for the request-triage skill, with the outcome that each
 * should get: 1 = do it now, 2 = compose a skill or workflow from existing
 * tools, 3 = a new capability is needed. They are for a manual run of the
 * instance (see "Evaluating a skill" in docs/openclaw.md), not for unit tests
 * of a model.
 */
export type TriageOutcome = 1 | 2 | 3;

export interface TriageSample {
  readonly id: string;
  readonly language: 'en' | 'ja';
  readonly request: string;
  readonly expected: TriageOutcome;
}

export const TRIAGE_SAMPLES: readonly TriageSample[] = [
  {
    expected: 1,
    id: 'now-test-en',
    language: 'en',
    request: 'Add a unit test for addLine in src/cart.ts.',
  },
  {
    expected: 1,
    id: 'now-validate-ja',
    language: 'ja',
    request:
      'src/cart.ts の addLine に、quantity が正の整数かを確認する処理を足してください。',
  },
  {
    expected: 1,
    id: 'now-run-tests-en',
    language: 'en',
    request:
      'Run the tests of the project repository and tell me which ones fail.',
  },
  {
    expected: 2,
    id: 'compose-checklist-en',
    language: 'en',
    request:
      'Create a skill that produces a test checklist for a given screen of the design documents and saves it as a Markdown file in the project repository.',
  },
  {
    expected: 2,
    id: 'compose-viewpoints-ja',
    language: 'ja',
    request:
      '設計書の画面一覧から、画面ごとの受け入れテスト観点を作るスキルを用意してください。',
  },
  {
    expected: 2,
    id: 'compose-diff-ja',
    language: 'ja',
    request:
      '設計書の変更履歴と、リポジトリの該当コードの差分を突き合わせて、不一致を一覧にするスキルが欲しいです。',
  },
  {
    expected: 3,
    id: 'new-mail-review-en',
    language: 'en',
    request:
      'When a mail arrives asking for a code review, open the review ledger Excel file, check out the branch that the mail names, review it, add the findings to the ledger and reply to the sender.',
  },
  {
    expected: 3,
    id: 'new-mail-intake-ja',
    language: 'ja',
    request:
      '社内メールで届いた不具合報告を自動で受け取って、台帳の Excel に追記してください。',
  },
  {
    expected: 3,
    id: 'new-mail-send-ja',
    language: 'ja',
    request: '毎週月曜に、設計書の変更点をチームにメールで送ってください。',
  },
];

/**
 * The outcome that an answer in the skill's form states, if it states one: the
 * `Outcome:` line, which is a line of its own that may carry Markdown emphasis.
 * An "Outcome: 3" quoted inside another line is not the answer.
 */
export const outcomeOf = (answer: string): TriageOutcome | undefined => {
  const match = /^[ \t]*\**[ \t]*Outcome:[ \t]*\**[ \t]*([123])\b/m.exec(
    answer,
  );
  const digit = match?.[1];
  return digit === '1' || digit === '2' || digit === '3'
    ? (Number(digit) as TriageOutcome)
    : undefined;
};
