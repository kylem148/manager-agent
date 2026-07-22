import fsp from "node:fs/promises";
import type { InstancePaths } from "../paths.js";
import { CrewPaneLayout } from "./crewpanes.js";
import type { DispatchConfig } from "./dispatchconfig.js";
import {
  chooseTransport,
  launchFallback,
  launchGhostty,
  parseSentinel,
  type TransportKind,
} from "./transport.js";

/**
 * The dispatch job registry and capture watcher.
 *
 * One registry per session. It owns every in-flight crew job: it launches each
 * on the chosen transport, polls its capture file for the completion sentinel,
 * enforces the wall-clock timeout, and drains the queue when a pane frees. It is
 * fully non-blocking: nothing here is ever awaited on the conversation path — the
 * session arms and fires a dispatch and moves on, and the registry notifies via a
 * callback when a job finishes. Multiple jobs run concurrently.
 *
 * Completion detection is by SENTINEL, not exit code: an interactive agent in a
 * Ghostty pane gives us no process to wait on, so both transports echo a sentinel
 * line into the capture file when the agent exits and we watch for it.
 */

export type JobStatus = "running" | "queued" | "done" | "failed";

export interface Job {
  id: string;
  /** The full order text handed to the agent. */
  order: string;
  /** A short human label for notices (first line of the order, trimmed). */
  label: string;
  transport: TransportKind;
  status: JobStatus;
  paneId?: string;
  pid?: number;
  captureFile: string;
  /** Epoch ms when the job started running (set on launch, not on queue). */
  startedAt: number | null;
  /** Exit code from the sentinel, once complete (-1 when unobservable). */
  exitCode?: number;
  /** Populated when status is "failed": why it failed to launch or run. */
  error?: string;
}

/** Fired when a job reaches a terminal state (done or failed). */
export type JobCompletionListener = (job: Job) => void;

const POLL_INTERVAL_MS = 750;

/** Injected clock, so tests aren't at the mercy of Date.now / real timers. */
export interface RegistryClock {
  now(): number;
}

export interface RegistryOptions {
  paths: InstancePaths;
  config: DispatchConfig;
  onComplete: JobCompletionListener;
  /** Overridable for tests; defaults to the real transport chooser. */
  transportOverride?: TransportKind;
  clock?: RegistryClock;
  pollIntervalMs?: number;
}

export class DispatchRegistry {
  private readonly paths: InstancePaths;
  private readonly config: DispatchConfig;
  private readonly onComplete: JobCompletionListener;
  private readonly clock: RegistryClock;
  private readonly pollIntervalMs: number;
  private readonly transport: TransportKind;

  private readonly jobs = new Map<string, Job>();
  /** FIFO of jobs waiting for a crew pane to free (Ghostty path, at cap). */
  private readonly queue: string[] = [];
  private readonly layout: CrewPaneLayout | null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private jobSeq = 0;
  private stopped = false;

  constructor(opts: RegistryOptions) {
    this.paths = opts.paths;
    this.config = opts.config;
    this.onComplete = opts.onComplete;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.transport = opts.transportOverride ?? chooseTransport();

    // The placement planner only exists on the Ghostty path AND only once an
    // anchor has been designated. Off Ghostty, or before `co pane`, there is no
    // geometry and every job runs immediately (visible-pane path degrades to
    // fallback if the anchor is missing — see dispatch()).
    this.layout =
      this.transport === "ghostty" && this.config.anchor
        ? new CrewPaneLayout(this.config.anchor, this.config.pane)
        : null;
  }

  /** The transport this registry will actually use for new jobs. */
  get activeTransport(): TransportKind {
    // A Ghostty environment without a designated anchor can't place panes, so it
    // behaves as fallback until `co pane` runs. Report that honestly.
    return this.transport === "ghostty" && !this.layout ? "fallback" : this.transport;
  }

  private nextJobId(): string {
    // Stable, sortable, collision-free within a session. Not time-based so tests
    // are deterministic; the session start already namespaces the capture dir.
    this.jobSeq += 1;
    return `job-${String(this.jobSeq).padStart(3, "0")}`;
  }

  /** Snapshot of all jobs, newest last. */
  list(): Job[] {
    return [...this.jobs.values()];
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Jobs currently running or queued. */
  activeCount(): number {
    return this.list().filter((j) => j.status === "running" || j.status === "queued").length;
  }

  /**
   * Launch (or queue) a dispatch for `order`. Returns the created Job. Never
   * throws into the caller: a launch failure marks the job failed and notifies,
   * so a bad dispatch can't crash the session. Starts the poller if idle.
   */
  async dispatch(order: string): Promise<Job> {
    const id = this.nextJobId();
    const label = firstLine(order);
    const captureFile = this.paths.captureFile(id);
    const job: Job = {
      id,
      order,
      label,
      transport: this.activeTransport,
      status: "running",
      captureFile,
      startedAt: this.clock.now(),
    };
    this.jobs.set(id, job);

    try {
      if (this.layout) {
        const launched = await this.launchOnPane(job);
        if (!launched) {
          // At the pane cap with nothing free: hold this job until one frees.
          job.status = "queued";
          job.startedAt = null;
          this.queue.push(job.id);
        }
      } else {
        const res = await launchFallback({ paths: this.paths, config: this.config, jobId: id, order });
        job.pid = res.pid;
      }
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message;
      // Notify asynchronously so dispatch() callers see a consistent return
      // before the completion callback fires.
      queueMicrotask(() => this.onComplete(job));
      return job;
    }

    this.ensurePolling();
    return job;
  }

  /**
   * Ghostty launch path: launchGhostty consults the planner (its single plan()).
   * Returns true if the job actually launched into a pane, false if the planner
   * said to queue (at the cap with nothing free). The caller owns queue bookkeeping.
   */
  private async launchOnPane(job: Job): Promise<boolean> {
    const res = await launchGhostty({
      paths: this.paths,
      config: this.config,
      layout: this.layout!,
      jobId: job.id,
      order: job.order,
    });
    if (res.placement && res.placement.kind === "queue") return false;
    job.paneId = res.paneId;
    return true;
  }

  /** Begin polling capture files if not already. */
  private ensurePolling(): void {
    if (this.poller || this.stopped) return;
    this.poller = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // Deliberately NOT unref'd: the poller is the mechanism that detects a job
    // finishing and drives the proactive review, so while jobs are in flight it
    // is legitimate work that should hold the event loop open. tick() clears the
    // timer once no job is active, and stop() clears it on every session-exit
    // path, so it can never outlive the work it watches.
  }

  /** One poll: check each running job for completion or timeout. */
  private async tick(): Promise<void> {
    const running = this.list().filter((j) => j.status === "running");
    for (const job of running) {
      await this.checkJob(job);
    }
    // Nothing left to watch and nothing queued: stop the timer.
    if (this.activeCount() === 0 && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private async checkJob(job: Job): Promise<void> {
    // Timeout first: a hung agent must not watch forever.
    const timeoutSec = this.config.caps.timeoutSec;
    if (timeoutSec && job.startedAt !== null) {
      const elapsed = (this.clock.now() - job.startedAt) / 1000;
      if (elapsed > timeoutSec) {
        this.killJob(job);
        this.finalize(job, "failed", { error: `timed out after ${timeoutSec}s` });
        return;
      }
    }

    let captured: string;
    try {
      captured = await fsp.readFile(job.captureFile, "utf8");
    } catch {
      return; // capture file not created yet; try again next tick
    }
    const sentinel = parseSentinel(captured);
    if (!sentinel) return;

    const status: JobStatus = sentinel.exitCode > 0 ? "failed" : "done";
    this.finalize(job, status, {
      exitCode: sentinel.exitCode,
      ...(status === "failed" ? { error: `agent exited ${sentinel.exitCode}` } : {}),
    });
  }

  /** Kill a fallback job's process group on timeout (no-op for pane jobs). */
  private killJob(job: Job): void {
    if (job.pid === undefined) return;
    try {
      // Negative pid targets the detached process group we created.
      process.kill(-job.pid, "SIGTERM");
    } catch {
      // Already gone, or not permitted; nothing more we can safely do.
    }
  }

  /** Move a job to a terminal state, free its pane, drain the queue, notify. */
  private finalize(job: Job, status: "done" | "failed", extra: Partial<Job>): void {
    job.status = status;
    Object.assign(job, extra);
    if (job.paneId && this.layout) {
      this.layout.finish(job.paneId);
      void this.drainQueue();
    }
    this.onComplete(job);
  }

  /**
   * A pane just freed: try to launch the oldest queued job. Re-plans through the
   * layout, so a freed pane is reused (or the job re-queues if the planner still
   * says to). Best-effort; a launch failure fails just that job.
   */
  private async drainQueue(): Promise<void> {
    if (!this.layout) return;
    while (this.queue.length > 0) {
      const nextId = this.queue[0]!;
      const job = this.jobs.get(nextId);
      if (!job || job.status !== "queued") {
        this.queue.shift(); // stale entry (job finished/removed); drop it
        continue;
      }
      // Mark running provisionally so launchOnPane's plan()/commit() treat it as
      // an active job; revert if the planner still says to queue.
      job.status = "running";
      job.startedAt = this.clock.now();
      let launched = false;
      try {
        launched = await this.launchOnPane(job);
      } catch (e) {
        this.queue.shift();
        job.status = "failed";
        job.error = (e as Error).message;
        this.onComplete(job);
        continue;
      }
      if (!launched) {
        // Still no room. Revert and stop; the next completion re-drains.
        job.status = "queued";
        job.startedAt = null;
        return;
      }
      this.queue.shift();
      this.ensurePolling();
    }
  }

  /** Stop the poller. Jobs keep running in their panes / background; we simply
   *  stop watching (called at session end). Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }
}

function firstLine(order: string): string {
  const line = order.split("\n").find((l) => l.trim() !== "")?.trim() ?? "dispatch";
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}
