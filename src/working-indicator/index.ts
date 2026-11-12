import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { formatDuration } from "../lib/format.ts";
import { createWorkingAnimation, SPINNER_INTERVAL_MS, WORD_INTERVAL_MS } from "./animation.ts";
import { PromptEditor } from "./prompt-editor.ts";

type Phase = "thinking" | "writing" | "tooling" | "waiting";

const THINKING_WORDS = [
  "Pondering",
  "Mulling",
  "Reasoning",
  "Contemplating",
  "Deliberating",
  "Calculating",
  "Percolating",
  "Brewing",
  "Distilling",
  "Imagining",
  "Conjuring",
  "Improvising",
  "Connecting",
  "Synthesizing",
  "Meandering",
  "Wibbling",
  "Frolicking",
  "Untangling",
  "Ruminating",
  "Theorizing",
  "Cogitating",
  "Musing",
  "Wondering",
  "Reflecting",
  "Introspecting",
  "Grappling",
  "Chewing",
  "Simmering",
  "Steeping",
  "Marinating",
  "Envisioning",
  "Hypothesizing",
  "Postulating",
  "Weaving",
  "Braiding",
  "Alchemizing",
  "Transmuting",
  "Delving",
  "Prospecting",
  "Unfolding",
  "Reckoning",
  "Weighing",
  "Tessellating",
  "Gamboling",
  "Daydreaming",
  "Wandering",
  "Chasing",
  "Brooding",
  "Philosophizing",
  "Speculating",
  "Discerning",
  "Crystallizing",
  "Coalescing",
  "Incubating",
  "Hatching",
  "Reframing",
  "Rehearsing",
  "Triaging",
  "Fleshing out",
  "Spiraling",
  "Bemusing",
  "Noodling",
  "Boiling down",
  "Whisking",
  "Effervescing",
  "Waxing",
  "Tackling",
  "Gleaning",
  "Coining",
  "Doodling",
  "Anchoring",
  "Grasping",
  "Pursuing",
  "Experimenting",
];

const WRITING_WORDS = [
  "Composing",
  "Sketching",
  "Constructing",
  "Assembling",
  "Refining",
  "Mapping",
  "Harmonizing",
  "Orchestrating",
  "Articulating",
  "Drafting",
  "Authoring",
  "Penning",
  "Inscribing",
  "Scribbling",
  "Transcribing",
  "Narrating",
  "Recounting",
  "Explaining",
  "Elaborating",
  "Expounding",
  "Depicting",
  "Painting",
  "Illustrating",
  "Formulating",
  "Polishing",
  "Buffing",
  "Trimming",
  "Pruning",
  "Carving",
  "Whittling",
  "Molding",
  "Stitching",
  "Stringing",
  "Crafting",
  "Forging",
  "Fashioning",
  "Fabricating",
  "Spinning",
  "Condensing",
  "Rewriting",
  "Revising",
  "Summarizing",
  "Framing",
  "Blueprinting",
  "Outlining",
  "Journaling",
  "Choreographing",
  "Publishing",
  "Calligraphing",
  "Copywriting",
  "Ghostwriting",
  "Songwriting",
  "Headlining",
  "Blurbing",
  "Footnoting",
  "Paraphrasing",
  "Translating",
  "Interpreting",
  "Rendering",
  "Expressing",
  "Enunciating",
  "Rhapsodizing",
  "Prosing",
  "Ranting",
  "Gushing",
  "Storyboarding",
  "Foreshadowing",
  "Bulletpointing",
  "Punctuating",
  "Anagramming",
  "Quipping",
  "Bantering",
  "Satirizing",
  "Parodying",
  "Mimicking",
];

const WAITING_WORDS = [
  "Transmitting",
  "Fetching",
  "Hailing",
  "Pinging",
  "Reaching out",
  "Buffering",
  "Awaiting",
  "Anticipating",
  "Handshaking",
  "Connecting",
  "Holding",
  "Lingering",
  "Loitering",
  "Twiddling",
  "Fidgeting",
  "Drumming",
  "Humming",
  "Whistling",
  "Staring",
  "Squinting",
  "Straining",
  "Listening",
  "Sounding",
  "Retrying",
  "Negotiating",
  "Inhaling",
  "Crossing",
  "Hoping",
  "Praying",
  "Pacing",
  "Glancing",
  "Biding",
  "Waiting",
  "Killing time",
  "Zoning out",
  "Bobbing",
  "Wriggling",
  "Swaying",
  "Rocking",
  "Jittering",
  "Fretting",
  "Wishing",
  "Knocking",
  "Tapping",
  "Dawdling",
  "Lollygagging",
  "Hanging",
  "Suspending",
  "Pausing",
  "Stalling",
  "Idling",
  "Coasting",
  "Gliding",
  "Hovering",
  "Floating",
  "Loading",
  "Spooling",
  "Queueing",
  "Polling",
  "Dialing",
  "Waving",
];

const TOOL_WORDS: Record<string, string[]> = {
  bash: [
    "Wrangling",
    "Rummaging",
    "Interrogating",
    "Spelunking",
    "Sifting",
    "Executing",
    "Bashing",
    "Crunching",
    "Churning",
    "Grinding",
    "Debugging",
    "Testing",
    "Scripting",
    "Automating",
    "Compiling",
    "Building",
    "Syncing",
    "Shuffling",
    "Tidying",
    "Cleaning",
    "Scrubbing",
    "Archiving",
    "Compressing",
    "Unpacking",
    "Fixing",
    "Profiling",
    "Benchmarking",
    "Counting",
    "Indexing",
    "Searching",
    "Mining",
    "Excavating",
    "Drilling",
    "Hammering",
    "Juggling",
    "Spawning",
    "Chaining",
    "Gluing",
    "Driving",
    "Racing",
    "Zipping",
    "Firing",
    "Piping",
    "Globbing",
    "Grepping",
    "Tunneling",
    "Networking",
    "Forking",
    "Streaming",
    "Redirecting",
    "Proxying",
    "Mirroring",
    "Restoring",
    "Resurrecting",
    "Encoding",
    "Hashing",
    "Escaping",
    "Recursing",
    "Deduping",
    "Normalizing",
    "Rotating",
    "Tailing",
    "Caching",
    "Fuzzing",
  ],
  read: [
    "Perusing",
    "Scanning",
    "Sifting",
    "Spelunking",
    "Navigating",
    "Investigating",
    "Deciphering",
    "Comparing",
    "Browsing",
    "Skimming",
    "Leafing",
    "Combing",
    "Scouring",
    "Dredging",
    "Unearthing",
    "Dissecting",
    "Parsing",
    "Tracing",
    "Following",
    "Tracking",
    "Sleuthing",
    "Inspecting",
    "Examining",
    "Studying",
    "Analyzing",
    "Digesting",
    "Absorbing",
    "Devouring",
    "Inhaling",
    "Peeking",
    "Peering",
    "Sniffing",
    "Surveying",
    "Auditing",
    "Reviewing",
    "Cross-referencing",
    "Extracting",
    "Lifting",
    "Poring",
    "Reading",
    "Thumbing",
    "Flipping",
    "Rifling",
    "Plumbing",
    "Grubbing",
    "Slogging",
    "Learning",
    "Highlighting",
    "Bookmarking",
    "Speed-reading",
    "Gobbling",
    "Bingeing",
    "Roaming",
    "Sweeping",
    "Raking",
    "Screening",
    "Re-reading",
    "Recalling",
  ],
  edit: [
    "Tinkering",
    "Refining",
    "Sculpting",
    "Shaping",
    "Editing",
    "Tweaking",
    "Nudging",
    "Adjusting",
    "Calibrating",
    "Tuning",
    "Trimming",
    "Pruning",
    "Carving",
    "Chiseling",
    "Whittling",
    "Shaving",
    "Sanding",
    "Filing",
    "Patching",
    "Mending",
    "Splicing",
    "Stitching",
    "Rewriting",
    "Swapping",
    "Injecting",
    "Removing",
    "Stripping",
    "Formatting",
    "Refactoring",
    "Simplifying",
    "Prettifying",
    "Tightening",
    "Sharpening",
    "Honing",
    "Revising",
    "Retouching",
    "Massaging",
    "Weeding",
    "Grafting",
    "Iterating",
    "Fiddling",
    "Jabbing",
    "Twisting",
    "Turning",
    "Etching",
    "Grooving",
    "Burnishing",
    "Glazing",
    "Varnishing",
    "Gilding",
    "Soldering",
    "Welding",
    "Fusing",
    "Melding",
    "Kneading",
    "Stretching",
    "Squishing",
    "Easing",
    "Quieting",
    "Silencing",
    "Uncommenting",
    "Renaming",
    "Duplicating",
    "Cutting",
    "Pasting",
    "Reverting",
    "Undoing",
    "Backtracking",
  ],
  write: [
    "Composing",
    "Constructing",
    "Assembling",
    "Sketching",
    "Writing",
    "Authoring",
    "Creating",
    "Generating",
    "Producing",
    "Crafting",
    "Forging",
    "Fashioning",
    "Fabricating",
    "Scaffolding",
    "Bootstrapping",
    "Prototyping",
    "Architecting",
    "Engineering",
    "Designing",
    "Concocting",
    "Baking",
    "Cooking",
    "Whipping up",
    "Manifesting",
    "Coding",
    "Programming",
    "Blueprinting",
    "Founding",
    "Planting",
    "Typing",
    "Dictating",
    "Seeding",
    "Sowing",
    "Cultivating",
    "Tending",
    "Growing",
    "Casting",
    "Emitting",
    "Outputting",
    "Exporting",
    "Dumping",
    "Persisting",
    "Saving",
    "Recording",
    "Forming",
    "Booting",
    "Spinning up",
    "Firing up",
    "Awakening",
    "Rousing",
  ],
  web_search: [
    "Searching",
    "Querying",
    "Googling",
    "Hunting",
    "Digging",
    "Probing",
    "Scanning",
    "Scouring",
    "Combing",
    "Sifting",
    "Filtering",
    "Trawling",
    "Netting",
    "Mining",
    "Crawling",
    "Prowling",
    "Sniffing",
    "Surveying",
    "Ranking",
    "Exploring",
    "Investigating",
    "Cross-checking",
    "Triangulating",
    "Verifying",
    "Fact-checking",
    "Sleuthing",
    "Scouting",
    "Tracking down",
    "Chasing leads",
    "Narrowing down",
    "Zeroing in",
    "Pinpointing",
    "Locating",
    "Discovering",
    "Unearthing",
    "Prospecting",
    "Panning",
    "Sourcing",
    "Angling",
    "Fishing",
    "Hunting down",
    "Looking up",
    "Checking",
  ],
  web_fetch: [
    "Fetching",
    "Retrieving",
    "Reading",
    "Pulling",
    "Downloading",
    "Grabbing",
    "Snagging",
    "Loading",
    "Opening",
    "Visiting",
    "Browsing",
    "Skimming",
    "Perusing",
    "Parsing",
    "Extracting",
    "Scraping",
    "Harvesting",
    "Ingesting",
    "Consuming",
    "Absorbing",
    "Devouring",
    "Citing",
    "Quoting",
    "Delving",
    "Diving into",
    "Paging through",
    "Thumbing",
    "Flipping through",
    "Loading up",
    "Pulling up",
    "Decoding",
    "Rendering",
    "Rummaging",
    "Combing through",
  ],
  subagent: [
    "Consulting",
    "Delegating",
    "Coordinating",
    "Orchestrating",
    "Summoning",
    "Dispatching",
    "Assigning",
    "Enlisting",
    "Recruiting",
    "Marshaling",
    "Supervising",
    "Stewarding",
    "Herding",
    "Corralling",
    "Deploying",
    "Outsourcing",
    "Briefing",
    "Relaying",
    "Spawning",
    "Splitting",
    "Cloning",
    "Hatching",
    "Mustering",
    "Rallying",
    "Gathering",
    "Conscripting",
    "Hiring",
    "Tasking",
    "Debriefing",
    "Directing",
    "Leading",
    "Guiding",
    "Mentoring",
    "Overseeing",
    "Shepherding",
    "Flocking",
    "Swarming",
    "Divvying",
    "Dividing",
    "Distributing",
    "Handing off",
    "Tag-teaming",
    "Partnering",
    "Collaborating",
    "Teaming up",
  ],
};

const ALL_WORDS = [...THINKING_WORDS, ...WRITING_WORDS, ...WAITING_WORDS, ...Object.values(TOOL_WORDS).flat()];
const TOOL_BUCKET_PREFIX = "tool:";

const WORKING_WIDGET_KEY = "working-indicator";

// Timers live in a process-global registry, not per-instance state: a runtime
// detached by /reload stops receiving events, so a timer created in the gap
// between session_shutdown and the fresh runtime would never be cleared by its
// own handlers. The fresh runtime clears the registry on session_start.
const TIMER_REGISTRY_KEY = "__pi_working_indicator_timers__";
const WORKING_GENERATION_KEY = "__pi_working_indicator_generation__";

function beginWorkingGeneration(): symbol {
  const generation = Symbol();
  (globalThis as Record<string, unknown>)[WORKING_GENERATION_KEY] = generation;
  return generation;
}

function isCurrentWorkingGeneration(generation: symbol): boolean {
  return (globalThis as Record<string, unknown>)[WORKING_GENERATION_KEY] === generation;
}

function liveTimers(): Set<ReturnType<typeof setInterval>> {
  const g = globalThis as Record<string, unknown>;
  const existing = g[TIMER_REGISTRY_KEY];
  if (existing instanceof Set) return existing;
  const created = new Set<ReturnType<typeof setInterval>>();
  g[TIMER_REGISTRY_KEY] = created;
  return created;
}

function clearAllWorkingTimers(): void {
  for (const timer of liveTimers()) clearInterval(timer);
  liveTimers().clear();
}

export default function (pi: ExtensionAPI) {
  let editorSession: symbol | undefined;

  let workingRunId = 0;
  let runtimeGeneration: symbol | undefined;
  let startedAt = 0;
  let renderWorkingMessage: (() => void) | undefined;
  let currentPhase: Phase = "thinking";
  let currentTool: string | undefined;
  const activeTools = new Set<string>();
  const lastWordIndexByBucket: Record<string, number> = {};

  const bucketFor = (phase: Phase, tool: string | undefined): string =>
    phase === "tooling"
      ? tool && TOOL_WORDS[tool]
        ? `${TOOL_BUCKET_PREFIX}${tool}`
        : `${TOOL_BUCKET_PREFIX}generic`
      : phase;

  const wordsFor = (bucket: string): string[] => {
    if (bucket.startsWith(TOOL_BUCKET_PREFIX)) return TOOL_WORDS[bucket.slice(TOOL_BUCKET_PREFIX.length)] ?? ALL_WORDS;
    return bucket === "thinking"
      ? THINKING_WORDS
      : bucket === "writing"
        ? WRITING_WORDS
        : bucket === "waiting"
          ? WAITING_WORDS
          : ALL_WORDS;
  };

  const pickWord = (bucket: string): string => {
    const words = wordsFor(bucket);
    const last = lastWordIndexByBucket[bucket] ?? -1;
    let index = Math.floor(Math.random() * words.length);
    while (words.length > 1 && index === last) index = (index + 1) % words.length;
    lastWordIndexByBucket[bucket] = index;
    return words[index] ?? words[0] ?? "Working";
  };

  pi.on("agent_start", (_event, ctx) => {
    if (runtimeGeneration === undefined || !isCurrentWorkingGeneration(runtimeGeneration)) return;
    clearAllWorkingTimers();
    const generation = runtimeGeneration;
    const runId = ++workingRunId;
    if (startedAt === 0) startedAt = Date.now();
    currentPhase = "thinking";
    currentTool = undefined;
    activeTools.clear();

    const animate = createWorkingAnimation();
    let lastSpinnerFrame = "";
    let lastWordCycle = -1;
    let lastBucket = "";
    let currentWord = "";
    let lastWorkingMessage = "";
    renderWorkingMessage = () => {
      if (runId !== workingRunId || !isCurrentWorkingGeneration(generation)) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      const cycle = Math.floor(elapsed / WORD_INTERVAL_MS);
      const bucket = bucketFor(currentPhase, currentTool);
      if (bucket !== lastBucket || cycle !== lastWordCycle) {
        lastBucket = bucket;
        lastWordCycle = cycle;
        currentWord = pickWord(bucket);
      }
      const { spinner, message } = animate(ctx.ui.theme, `${currentWord}…`, elapsed);
      if (spinner !== lastSpinnerFrame) {
        lastSpinnerFrame = spinner;
        ctx.ui.setWorkingIndicator({ frames: [spinner], intervalMs: SPINNER_INTERVAL_MS });
      }
      const workingMessage = `${message} ${ctx.ui.theme.fg("dim", formatDuration(elapsed))}`;
      if (workingMessage !== lastWorkingMessage) {
        lastWorkingMessage = workingMessage;
        ctx.ui.setWorkingMessage(workingMessage);
      }
    };
    renderWorkingMessage();
    ctx.ui.setWorkingVisible(true);
    let timer: ReturnType<typeof setInterval>;
    timer = setInterval(() => {
      if (runId !== workingRunId || !isCurrentWorkingGeneration(generation)) {
        clearInterval(timer);
        liveTimers().delete(timer);
        return;
      }
      renderWorkingMessage?.();
    }, SPINNER_INTERVAL_MS);
    timer.unref?.();
    liveTimers().add(timer);
  });

  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") return;
    startedAt = Date.now();
    renderWorkingMessage?.();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    switch (event.assistantMessageEvent.type) {
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        currentPhase = "thinking";
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
        currentPhase = "writing";
        break;
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        currentPhase = "tooling";
        break;
    }
    renderWorkingMessage?.();
  });

  pi.on("turn_start", () => {
    currentPhase = "thinking";
    currentTool = undefined;
    renderWorkingMessage?.();
  });

  pi.on("tool_execution_start", (event) => {
    currentPhase = "tooling";
    currentTool = event.toolName;
    activeTools.add(event.toolCallId);
    renderWorkingMessage?.();
  });

  pi.on("tool_execution_end", (event) => {
    activeTools.delete(event.toolCallId);
    if (activeTools.size === 0) {
      currentPhase = "thinking";
      currentTool = undefined;
    }
    renderWorkingMessage?.();
  });

  pi.on("before_provider_request", () => {
    currentPhase = "waiting";
    renderWorkingMessage?.();
  });

  pi.on("after_provider_response", () => {
    currentPhase = "thinking";
    renderWorkingMessage?.();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (runtimeGeneration === undefined || !isCurrentWorkingGeneration(runtimeGeneration) || !ctx.isIdle()) return;
    workingRunId++;
    clearAllWorkingTimers();
    renderWorkingMessage = undefined;
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWorkingVisible(false);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (runtimeGeneration === undefined || !isCurrentWorkingGeneration(runtimeGeneration)) return;
    runtimeGeneration = undefined;
    editorSession = undefined;
    workingRunId++;
    clearAllWorkingTimers();
    renderWorkingMessage = undefined;
    startedAt = 0;
    ctx.ui.setWidget(WORKING_WIDGET_KEY, undefined);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWorkingVisible(false);
  });

  pi.on("session_start", (_event, ctx) => {
    editorSession = undefined;
    if (ctx.mode === "tui") {
      const session = (editorSession = Symbol());
      let editorInstance: symbol | undefined;
      let currentComponent: Component | undefined;
      let ownsCurrentEditor: (() => boolean) | undefined;
      let disposed = false;
      let requestRender: (() => void) | undefined;
      ctx.ui.setWidget(
        WORKING_WIDGET_KEY,
        (tui) => {
          requestRender = () => tui.requestRender();
          return {
            render: (width) => (ownsCurrentEditor?.() ? (currentComponent?.render(width) ?? []) : []),
            invalidate: () => {
              if (ownsCurrentEditor?.()) currentComponent?.invalidate();
            },
            dispose: () => {
              disposed = true;
              currentComponent = undefined;
              ownsCurrentEditor = undefined;
              requestRender = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      const factory: NonNullable<Parameters<typeof ctx.ui.setEditorComponent>[0]> = (tui, theme, keybindings) => {
        const instance = (editorInstance = Symbol());
        currentComponent = undefined;
        ownsCurrentEditor = undefined;
        requestRender?.();
        let editorDetached = false;
        const ownsEditor = () => {
          if (ctx.ui.getEditorComponent() !== factory) editorDetached = true;
          return editorSession === session && editorInstance === instance && !editorDetached && !disposed;
        };
        return new PromptEditor(
          tui,
          theme,
          keybindings,
          () => ctx.ui.theme,
          (component) => {
            if (!ownsEditor()) return;
            currentComponent = component;
            ownsCurrentEditor = ownsEditor;
            requestRender?.();
          },
        );
      };
      ctx.ui.setEditorComponent(factory);
    }
    if (ctx.hasUI === false) return;
    // Invalidate callbacks from a runtime being replaced during reload. A
    // callback can already be queued even after its timer was cleared.
    runtimeGeneration = beginWorkingGeneration();
    workingRunId++;
    clearAllWorkingTimers();
    renderWorkingMessage = undefined;
    currentPhase = "thinking";
    currentTool = undefined;
    activeTools.clear();
    startedAt = Date.now();
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWorkingVisible(false);
  });
}
