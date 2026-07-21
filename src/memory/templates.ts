/**
 * Seed content for a fresh instance's .memory/ substrate: the orientation files
 * (projectbrief, activeContext) and log headers, written on `co create`.
 * Templates only fill gaps, never overwrite existing content. User-facing docs
 * (architecture.md, plan.md, ...) are NOT seeded — they are authored when their
 * workflow begins, so docs/ starts empty. The protocol reference text that used
 * to seed shared/ now lives in prompt.ts, assembled directly into the system
 * prompt.
 */

export function projectbriefTemplate(name: string, dateISO: string): string {
  return `# Project brief: ${name}

_Created ${dateISO}. Keep this compact; it is read at every session start._

## What this project is
(one paragraph - describe the software project this co-manager supports)

## Goals
-

## Hard constraints
-

## Non-goals
-
`;
}

export function activeContextTemplate(name: string, dateISO: string): string {
  return `# Active context: ${name}

_Last synced ${dateISO}. This is the orientation file - the co-manager reads
this first. Keep it current and compact._

## Current focus
(what we are actively working through right now)

## Being decided now
-

## Recent confirmed decisions (compressed)
(see .memory/decisions.md for full entries)

## Recent conversation
(A short rolling summary of the recent back-and-forth that has NOT yet hardened
into a decision or a log entry - the casual "where we are" thread. Rewrite this
each session; keep it to a few tight bullets, letting older detail age out into
the logs. This is what lets the next session pick up naturally.)

## In flight
-

## Known risks
-

## Open questions
-

## Next likely actions
-
`;
}

export function architectureTemplate(name: string, dateISO: string): string {
  return `# Architecture: ${name}

_Last updated ${dateISO}. The current architectural picture - rewritten in
place as it changes._

## Overview
(one paragraph)

## Components
-

## Data flow
(describe how data moves through the system)

## Key technology choices
| Area | Choice | Why |
| ---- | ------ | --- |

## Open architectural questions
-
`;
}

export function logHeader(title: string): string {
  return `# ${title}

_Append-only log. Newest entries at the bottom. Not read in full by default -
searched or read by range on demand._
`;
}
