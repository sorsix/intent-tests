// The develop-mode protocol between `intent-test develop` (the engine child) and its client (Intent Launcher's main
// process). This file is the contract (docs/develop-mode.md, section 3): newline-delimited JSON, requests on the child's
// stdin, replies and events on its stdout, nothing else on stdout. `docs/contract/develop-protocol.schema.json` is
// generated from these types; Launcher keeps mirrors (`launcher/desktop/src/shared/develop.ts`,
// `launcher/src/assistant/develop/protocol.ts`) whose tests validate sample messages against that schema.

/** One case of the app as the case list shows it. `id` is the explicit id (`<id>` or `<id>[<row key>]` for a template row). */
export type CaseSummary = {
  id: string;
  name: string;
  /** Relative to the app folder. */
  file: string;
  line: number;
  tags: string[];
  /**
   * `tags` contains `@draft`: skipped by `intent-test run` unless AT_INCLUDE_DRAFTS=true (a draft without steps always).
   * Only a draft may have no steps yet; only a draft can be discarded.
   */
  draft: boolean;
  /** The `refs:` line, e.g. TestRail case ids. */
  refs: string[];
  session?: string;
  seed?: string;
  /** For a case of a parameterized template: the template's explicit id. */
  template?: string;
};

/** One of the case's own steps, as written in its section (0-based `index`; `number` and `label` as the parser numbers them). */
export type DevelopStep = {
  index: number;
  number: number;
  label: string;
  text: string;
  kind: string;
  line: number;
  /** For a `use` step: the inlined steps it expands to. */
  expanded?: { label: string; text: string; kind: string }[];
};

/** A seed of the app's `seeds.ts`, as `cases` lists them for the Seed choosers. */
export type SeedInfo = { name: string; description?: string };

export type DevelopCase = CaseSummary & {
  steps: DevelopStep[];
  /** The parameter row of a template case. */
  parameters?: Record<string, string>;
};

/**
 * A `## Steps:` block loaded in the rail (`load_block`): its own steps as written (a `use` step with its expansion, as
 * for a case) and the cases that use it. While it is loaded, the step requests act on it instead of a case.
 */
export type DevelopBlock = {
  name: string;
  /** Relative to the app folder. */
  file: string;
  /** 1-based line of its heading. */
  line: number;
  steps: DevelopStep[];
  /** The cases that start from it (`session:`), inline it (`use`) or continue as it (`switch to session`), in file order. */
  usedBy: { caseId: string; as: 'session' | 'use' | 'switch' }[];
};

/** The reply to an edit while a block is loaded, also the `block.updated` payload. */
export type BlockUpdate = {
  block: DevelopBlock;
  /** Relative to the app folder. */
  file: string;
  saved: boolean;
  /** The parser's message when the saved file does not parse, or why it could not be saved. */
  error?: string;
};

/** What running or verifying one step produced; derived from `StepRecord` in `src/steps.ts`. */
export type DevelopStepRecord = {
  index: number;
  status: 'passed' | 'failed';
  durationMs: number;
  modelMs: number;
  chosen?: { id: string; description: string; confidence: number };
  /** The model's ranked answers, best first. */
  top?: { id: string; description: string; p: number }[];
  /** The elements the resolver offered as answer options. */
  candidates?: { id: string; description: string }[];
  outcome?: string;
  error?: string;
  failure?: { kind: string; summary: string; detail?: string };
  /** Base64 JPEG taken before the action, as in reports. */
  screenshot?: string;
  screenshotFallback?: boolean;
  condition?: string;
  /** Base64 JPEG of the viewport after the step (at most 640 px wide); absent when the capture failed. */
  after?: string;
  /** What the page reported while the step ran (docs/develop-mode.md, section 3.6). */
  page?: PageActivity;
};

/**
 * The page's own errors during one step: uncaught exceptions, console errors and warnings, and requests that answered
 * 400 or above or failed. At most 20 entries per list, texts cut to 300 characters, URLs without query or fragment.
 */
export type PageActivity = {
  errors: string[];
  console: { level: 'error' | 'warning'; text: string }[];
  requests: { method: string; url: string; status?: number; failure?: string }[];
};

/** The result of `verify_step`: the resolver's decision without acting. */
export type Verification = {
  chosen?: { id: string; description: string; confidence: number };
  confidence?: number;
  top: { id: string; description: string; p: number }[];
  candidates: { id: string; description: string }[];
  /** Why nothing was chosen (the model answered none, or was unsure). */
  reason?: string;
};

/**
 * The reply to `describe_point` (Pick): the actionable element at a viewport point as the resolver reads it, the target
 * wording the recorder would write for it (`target`, and `context` such as `in the "Booking" dialog`), and ready-made
 * steps to insert. A non-interactive element with visible text gets one `expect … shows "<text>"` step scoped like a
 * target; nothing under the point gives `steps: []` with `reason`.
 */
export type PointDescription = {
  element?: DescribedElement;
  /** The element's target phrase, e.g. `the "Save" button`. */
  target?: string;
  /** Where it is, as the step wording says it, e.g. `in the "Booking" dialog`; absent when it has no context. */
  context?: string;
  steps: {
    kind: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'expect';
    text: string;
  }[];
  reason?: string;
};

/** A snapshot element as the decider reads it (`describe()` in `src/snapshot.ts`). */
export type DescribedElement = { id: string; kind: string; description: string };

export type SnapshotResult = {
  url: string;
  title: string;
  /** Title of the open modal dialog (`''` for one without a title), or null. */
  dialog: string | null;
  headings: string[];
  elements: DescribedElement[];
};

/** CDP input replayed into the page. Coordinates are viewport CSS pixels; `modifiers` follow CDP (Alt 1, Ctrl 2, Meta 4, Shift 8). */
export type InputEvent =
  | {
      kind: 'mouse';
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right' | 'none';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      kind: 'key';
      type: 'keyDown' | 'keyUp' | 'char';
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
      windowsVirtualKeyCode?: number;
    }
  | { kind: 'insertText'; text: string };

/** A step the recorder derived from the person's actions in the browser (docs/develop-mode.md, section 3.4). */
export type RecordedStep = {
  /** Milliseconds since the epoch when the action happened; identifies the step in `recorded.verified`. */
  at: number;
  kind: 'open' | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press';
  /** Grammar-valid step text, e.g. `click the "Save" button in the "Booking" dialog`. */
  text: string;
  elementId?: string;
  description?: string;
  value?: string;
  /** A password field: no value is recorded and the text uses `{{PASSWORD}}`. */
  secret?: boolean;
  url?: string;
};

export type SessionState = 'closed' | 'starting' | 'ready' | 'failed';

/**
 * What `{{seed.<key>}}`, `{{saved.<name>}}` and `{{param.<key>}}` stand for in the open session: the seed's result, the
 * values `call … and save` steps saved, and the template row. Never environment variables. A value whose key matches
 * /pass|secret|token|key/i is "••••"; other values are text (non-strings as JSON), cut to 200 characters.
 */
export type SessionVariables = {
  seed: Record<string, string>;
  saved: Record<string, string>;
  param: Record<string, string>;
};

export type ReadyInfo = {
  engineVersion: string;
  app: string;
  appDir: string;
  /** Absolute paths of documents an agent may read: the test grammar, and (from 0.21.3) the authoring primer. */
  docs: { testFormat: string; authoring?: string };
  /**
   * The base URL a `start` uses while no start has chosen one: `BASE_URL` from the environment, else the app config's
   * `webServer` URL, or null when neither is set. Absent from engines older than `start.baseUrl`, which ignore that
   * field; Launcher then offers no other base.
   */
  baseUrl?: string | null;
  /**
   * The request types this engine answers (from 0.23.0). Launcher offers only what the engine has and names the
   * release to install for the rest; engines that send no list are judged by their version.
   */
  requests?: DevelopRequestType[];
};

/** Requests, client → engine. Every request carries a client-chosen `id` that the reply repeats. */
export type DevelopRequest =
  | { id: string; type: 'hello' }
  | { id: string; type: 'cases' }
  | { id: string; type: 'load'; caseId: string }
  /** Loads a `## Steps:` block into the rail instead of a case: its steps are edited, run and verified in the open session. */
  | { id: string; type: 'load_block'; name: string }
  | {
      id: string;
      type: 'new_case';
      /**
       * Relative to the app folder; created when missing. Absent, or a folder ending in "/": the file is named after the
       * case (`<folder><slug of the name>.md`). A nameless or hidden file (`booking/.md`) is refused.
       */
      file?: string;
      name: string;
      caseId?: string;
      session?: string;
      seed?: string;
    }
  | {
      id: string;
      type: 'start';
      /**
       * An absolute http(s) address: its origin becomes the session's base URL (login, `open` paths, `navigate`) for
       * this and later starts, so an agent's start opens the environment the person chose. `null` returns to the
       * default (`ReadyInfo.baseUrl`); absent keeps the current choice.
       */
      baseUrl?: string | null;
    }
  | { id: string; type: 'stop' }
  | { id: string; type: 'run_step'; index: number }
  | { id: string; type: 'run_from'; index: number }
  | { id: string; type: 'verify_step'; index: number; text?: string }
  | {
      id: string;
      type: 'describe_point';
      /** Viewport CSS pixels, the frame of reference of `input` and `frame.viewport`. */
      x: number;
      y: number;
    }
  | {
      id: string;
      type: 'suggest_step';
      /** An own click, fill, select, check, uncheck or expect step (0-based). */
      index: number;
      /**
       * For an element step, an id from that step's last record in this session (`top[].id` or `candidates[].id`); for
       * an expect (whose record lists no elements), an id from `snapshot`. The page is read again: a changed page is
       * refused.
       */
      elementId: string;
    }
  | { id: string; type: 'edit_step'; index: number; text: string }
  | { id: string; type: 'insert_step'; index: number; text: string }
  | { id: string; type: 'delete_step'; index: number }
  | {
      id: string;
      type: 'set_meta';
      draft?: boolean;
      refs?: string[];
      /** A `## Steps:` block name for the `session:` line (refused when undefined in the app); null removes the line. */
      session?: string | null;
      /** A seed name for the `seed:` line (refused when `seeds.ts` lacks it); null removes the line. */
      seed?: string | null;
    }
  | {
      id: string;
      type: 'discard_case';
      /** A case tagged `@draft` (`<id>` or `<id>[<row key>]`): its whole `## Test:` section is removed from its file. */
      caseId: string;
    }
  // Promotes the loaded draft: a fresh session (as `start`, with the base last chosen), every own step in order
  // (stopping at the first failure), then `@draft` removed only when all passed and `refs` is filled. `runs` (1 to 5,
  // default 1) repeats that from a fresh session each time, stopping at the first failed run; the tag goes only when
  // every run passed.
  | { id: string; type: 'promote'; runs?: number }
  | {
      id: string;
      type: 'duplicate_case';
      /** The case to copy (`<id>` or `<id>[<row key>]`; a template row copies its whole template). */
      caseId: string;
      /** The copy's name; absent: "Copy of <name>". Its id is the name's slug, made unique; without a name, `<id>-copy`. */
      name?: string;
      /**
       * Relative to the app folder; created when missing. Absent: the case's own file. A folder ending in "/": the file is
       * named after the copy (`<folder><slug of the name>.md`), as for `new_case`.
       */
      file?: string;
    }
  | {
      id: string;
      type: 'rename_case';
      caseId: string;
      /** A new `id:` value, unused in the app. The dashboard keeps a case's history under its id. */
      newId?: string;
      /** A new `## Test:` name, unused in the case's file. */
      name?: string;
    }
  | {
      id: string;
      type: 'move_case';
      /** Any case (not only drafts): its whole `## Test:` section leaves its file. */
      caseId: string;
      /** Relative to the app folder; created when missing. A folder ending in "/" names the file after the case. */
      file: string;
    }
  | { id: string; type: 'snapshot' }
  | { id: string; type: 'page_text' }
  | { id: string; type: 'page_selection' }
  /** Every own step of every case whose text contains `query`, ignoring case. Needs no session. */
  | { id: string; type: 'search_steps'; query: string }
  | {
      id: string;
      type: 'replace_text';
      /** The exact text between the quotes of the label to rename; not empty. */
      from: string;
      /** The new label; no double quote. */
      to: string;
      /** Write the files; absent or false only lists the changes (a preview). Needs no session. */
      apply?: boolean;
    }
  | { id: string; type: 'navigate'; path: string }
  | { id: string; type: 'screencast'; enabled: boolean; maxWidth?: number; quality?: number }
  | { id: string; type: 'input'; event: InputEvent }
  | { id: string; type: 'record'; enabled: boolean }
  | { id: string; type: 'recording' }
  | { id: string; type: 'clear_recording' }
  | { id: string; type: 'variables' };

export type DevelopRequestType = DevelopRequest['type'];

/** The reply to an edit (`edit_step`, `insert_step`, `delete_step`, `set_meta`), also the `case.updated` payload. */
export type CaseUpdate = {
  case: DevelopCase;
  /** Relative to the app folder. */
  file: string;
  saved: boolean;
  /** The parser's message when the saved file does not parse, or why it could not be saved. */
  error?: string;
};

/**
 * The reply to `discard_case`, also the `case.discarded` payload: the draft's section is gone from `file`, which was
 * deleted too (`fileRemoved`) when nothing but whitespace was left in it. A discarded case that was loaded is unloaded.
 */
export type CaseDiscarded = {
  /** The explicit id of the discarded case, as `load` resolves it. */
  caseId: string;
  /** Relative to the app folder. */
  file: string;
  fileRemoved: boolean;
};

/**
 * The reply to `promote`. `passed`: every step passed in a fresh session, in every run (`stoppedAt` is the first step
 * that failed, in the last run). `promoted`: `@draft` was removed (through `set_meta`, so `case.updated` was emitted); otherwise `reason` says why not.
 */
export type PromoteResult = {
  passed: boolean;
  /** How many runs ran (`promote.runs`, fewer when one failed). */
  runs: number;
  /** The last run's records. */
  records: DevelopStepRecord[];
  stoppedAt?: number;
  promoted: boolean;
  /** Why the draft tag stays when every step passed: `add refs first` when the case has no `refs:`. */
  reason?: string;
};

/**
 * The reply to `move_case`: the case's section left `from` (deleted too when nothing but whitespace was left in it,
 * `fileRemoved`) and was appended to `to`. The case is loaded afterwards; `case.updated` names `to`.
 */
export type CaseMoved = {
  case: DevelopCase;
  /** Relative to the app folder. */
  from: string;
  /** Relative to the app folder. */
  to: string;
  fileRemoved: boolean;
  /** The parser's message when the app does not parse afterwards. */
  error?: string;
};

/** What the `expect` judge reads (`pageText()` in `src/snapshot.ts`), the reply to `page_text`. */
export type PageText = {
  url: string;
  title: string;
  dialog: { title: string; text: string } | null;
  /** Visible tables; `section` is the heading path above it, e.g. "Studies › Per hour". */
  tables: { caption: string; section?: string; rows: Record<string, string>[] }[];
  fields: { label: string; value: string }[];
  /** Buttons and links: per table row, and the rest of the page. */
  actions: {
    rows: { table: string; row: number; cells: Record<string, string>; actions: string[] }[];
    other: string[];
  };
  /** Visible text in reading order, headings and named sections as "#" lines. */
  visibleText: string;
};

/** The reply to `page_selection`: the text selected in the page, for an `expect` step in its exact wording. */
export type PageSelection = {
  /** The main frame's selection, whitespace runs collapsed to one space, trimmed, at most 500 characters; `''` when nothing is selected. */
  text: string;
  /** The open dialog's title when the selection is in it, else the nearest heading or named section above it (as `page_text` marks them); absent when there is none or nothing is selected. */
  scope?: string;
};

/** One own step a `search_steps` query found, in file order. */
export type StepMatch = {
  /** The case as `cases` lists it (a template's first row). */
  caseId: string;
  name: string;
  /** Relative to the app folder. */
  file: string;
  /** 1-based line of the step in the file. */
  line: number;
  /** 0-based index of the own step, as `load` numbers them. */
  index: number;
  /** The step text as written. */
  text: string;
};

/** One step line `replace_text` changes (a preview) or changed (applied). */
export type TextChange = {
  /** Relative to the app folder. */
  file: string;
  /** 1-based line in the file. */
  line: number;
  /** The `id:` of the case the step belongs to; absent for a step of a `## Steps:` block. */
  caseId?: string;
  /** The step text before and after the rename. */
  before: string;
  after: string;
};

/** Reply payloads per request type (`result` of a successful reply). Requests not listed reply `{}`. */
export type DevelopResults = {
  hello: ReadyInfo;
  /**
   * `sessions`: every `## Steps:` block (any can be a `session:`), the ones already used as sessions first. `error`: the
   * parser's message when the app does not parse (a half-edited file); the cases are then read from the files' sections
   * as written, template rows not expanded. A new case without steps is a draft and parses.
   */
  cases: { cases: CaseSummary[]; sessions: string[]; seeds: SeedInfo[]; error?: string };
  /** `error`: the parser's message when the app does not parse (the case is then read from its section's text). */
  load: { case: DevelopCase; error?: string };
  /** `error`: the parser's message when the app does not parse (the block is then read from its section's text). */
  load_block: { block: DevelopBlock; error?: string };
  new_case: { case: DevelopCase; error?: string };
  /** `variables`: the session's values after login and seed (engines before the field omit it). */
  start: { url: string; variables?: SessionVariables };
  run_step: { record: DevelopStepRecord };
  run_from: { records: DevelopStepRecord[]; stoppedAt?: number };
  verify_step: Verification;
  describe_point: PointDescription;
  /** The step rewritten to target the element; nothing is saved (apply it with `edit_step`). */
  suggest_step: { text: string };
  edit_step: CaseUpdate | BlockUpdate;
  insert_step: CaseUpdate | BlockUpdate;
  delete_step: CaseUpdate | BlockUpdate;
  set_meta: CaseUpdate;
  discard_case: CaseDiscarded;
  promote: PromoteResult;
  /** The copy, loaded (`case.loaded`). */
  duplicate_case: { case: DevelopCase; error?: string };
  /** The renamed case, loaded (`case.updated`). */
  rename_case: CaseUpdate;
  move_case: CaseMoved;
  snapshot: SnapshotResult;
  page_text: PageText;
  page_selection: PageSelection;
  /** At most 200 matches, in file order. */
  search_steps: { matches: StepMatch[] };
  /** `applied`: the files were rewritten (`apply: true` and at least one change). */
  replace_text: { changes: TextChange[]; applied: boolean };
  navigate: { url: string };
  recording: { steps: RecordedStep[] };
  /** The open session's values, all three empty while no session is open. */
  variables: SessionVariables;
};

export type DevelopReply =
  | { id: string; ok: true; result: Record<string, unknown> }
  | { id: string; ok: false; error: string; hint?: string };

/** Events, engine → client; no `id`. */
export type DevelopEvent =
  | ({ event: 'ready' } & ReadyInfo)
  | { event: 'case.loaded'; case: DevelopCase }
  | ({ event: 'case.updated' } & CaseUpdate)
  /** A `## Steps:` block is loaded instead of a case (`load_block`); the case, if one was loaded, is unloaded. */
  | { event: 'block.loaded'; block: DevelopBlock }
  | ({ event: 'block.updated' } & BlockUpdate)
  | ({ event: 'case.discarded' } & CaseDiscarded)
  | { event: 'session.state'; state: SessionState; url?: string; error?: string }
  /** After `start` (login and seed done), and after an own step that changed a value. */
  | { event: 'variables'; variables: SessionVariables }
  | { event: 'step.started'; index: number }
  | { event: 'step.finished'; index: number; record: DevelopStepRecord }
  | {
      event: 'frame';
      /** Base64 JPEG. */
      data: string;
      width: number;
      height: number;
      viewport: { width: number; height: number };
      url: string;
    }
  | { event: 'recorded'; step: RecordedStep }
  | {
      event: 'recorded.verified';
      at: number;
      verification: { chosenId?: string; confidence?: number; matches: boolean; reason?: string };
    }
  | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Anything the engine writes to stdout. */
export type DevelopMessage = DevelopReply | DevelopEvent;

export const isReply = (message: DevelopMessage): message is DevelopReply => 'id' in message;
export const isEvent = (message: DevelopMessage): message is DevelopEvent => 'event' in message;

/**
 * What the Launcher socket adds (docs/develop-mode.md, section 4.2): the first line a socket client sends, and the
 * engine's `ready` payload plus the loaded case that Launcher answers with.
 */
export type SocketHello = { hello: { token: string } };
export type SocketHelloReply = {
  hello: ReadyInfo & {
    case?: DevelopCase;
    session: SessionState;
    testrail?: { url: string; user: string; apiKey: string };
    /** The product and app the develop session belongs to, for the authoring guide. */
    product?: { key: string; app: string };
  };
};
