# Scheduled Tasks (Per-Project) Plan

Goal: per-project scheduled tasks (prompt + provider/model + agent) that run automatically at user-defined times, create a new session, and send the configured prompt. UI is web-only. Desktop is just a shell. VSCode is explicitly out of scope.

Hard requirements from product
1. UI entrypoint is a header icon button in Sessions sidebar header (`RiCalendarScheduleLine`).
2. Scheduled tasks live in a dedicated dialog (not Settings).
3. Dialog includes project selector dropdown.
4. Dialog lists existing tasks and supports add/edit/delete, enable/disable, and “Run now”.
5. A run creates a new session and sends the prompt.
6. Session title format: `<task_name> <date> <time>`.
7. Scheduler runs server-side (web server runtime), not in UI.
8. Refresh hint/reconcile for the global sessions sidebar after background runs.

---

## Architecture Summary

Single source of truth is the web server.
1. Storage: per-project scheduled-task config persisted on disk, owned by server.
2. API: server exposes CRUD + run endpoints to UI.
3. Scheduler: server maintains an in-memory schedule, computes next run, triggers execution, persists run metadata, and emits UI events.
4. UI: Session Sidebar header button opens a dialog; dialog calls API; dialog uses project dropdown; editor is a nested dialog.
5. UI refresh: server emits an SSE event stream for OpenChamber-specific events; UI listens and triggers targeted reconciliation.

---

## Data Model

### Task record

JSON shape (server-owned, validated, sanitized):

```ts
type ScheduledTask = {
  id: string
  name: string
  enabled: boolean
  schedule: {
    kind: 'daily' | 'weekly' | 'cron'
    time?: string        // 'HH:mm' required for daily/weekly
    weekdays?: number[]  // 0-6 (Sun-Sat), required for weekly
    cron?: string        // required for cron
    timezone?: string    // IANA (eg 'Europe/Kyiv'); default = server local tz
  }
  execution: {
    prompt: string
    providerID: string
    modelID: string
    variant?: string
    agent?: string
  }
  state: {
    lastRunAt?: number
    lastStatus?: 'idle' | 'running' | 'success' | 'error'
    lastError?: string
    lastDurationMs?: number
    lastSessionId?: string
    nextRunAt?: number
    updatedAt: number
    createdAt: number
  }
}
```

Server rules
1. `id` is generated server-side (UUID).
2. Max lengths:
   - `name` <= 80
   - `prompt` <= 20_000 (or smaller if desired)
   - `cron` <= 200
   - `lastError` <= 2_000
3. `timezone` must be a valid IANA tz id. If absent, use server local timezone.
4. `providerID` and `modelID` must be non-empty strings. Validation should be strict for safety.
5. `agent` and `variant` are optional, trimmed.

### Session title

Title is generated at execution time.
1. Use task timezone to format `date` and `time`.
2. Format: `${task.name} ${YYYY-MM-DD} ${HH:mm}`.
3. Enforce a hard max length (eg 120 chars) by trimming task name.

---

## Persistence

Production-ready storage constraints
1. Must survive server restart.
2. Must be per-project.
3. Must not depend on UI runtime filesystem APIs.
4. Must be atomic and resilient to partial writes.

Recommended storage
1. Store tasks in server-owned per-project config files under `~/.config/openchamber/projects/<projectId>.json`.
2. This aligns with existing project-scoped config precedent.
3. Server must own read/write and expose it via API.

Implementation notes
1. Add a server module `packages/web/server/lib/projects/project-config.js` that:
   - resolves project config path by `projectId`
   - reads JSON with safe parsing
   - writes JSON atomically (write temp + rename)
   - validates and sanitizes scheduled tasks
2. Do not have the UI write these files directly.

---

## Server API

All routes must be behind existing UI auth/guard middleware (same trust boundary as other `/api/*`).

Endpoints
1. `GET /api/projects/:projectId/scheduled-tasks`
   - returns `{ tasks: ScheduledTask[] }`
2. `PUT /api/projects/:projectId/scheduled-tasks`
   - body: `{ tasks: ScheduledTask[] }` or `{ upsert: ScheduledTask }` (choose one, prefer minimal and safe)
   - returns updated `{ tasks: ScheduledTask[] }`
3. `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
   - body: optional overrides are NOT allowed in production (avoid privilege escalation)
   - returns `{ ok: true, task: ScheduledTask, sessionId?: string }`
4. `DELETE /api/projects/:projectId/scheduled-tasks/:taskId`
   - returns updated `{ tasks: ScheduledTask[] }`

Validation rules
1. Reject unknown projectId.
2. Reject tasks referencing invalid schedule config.
3. Reject invalid timezone.
4. Reject empty provider/model.
5. Reject empty prompt.
6. Reject edits to immutable fields (`id`, `createdAt`) unless server is creating.

---

## Scheduler Runtime

Location
1. `packages/web/server/lib/opencode/scheduled-tasks-runtime.js`
2. Wired from `packages/web/server/index.js` composition root.

Responsibilities
1. Load all tasks for all configured projects on startup.
2. Maintain an in-memory index:
   - `projectId -> taskId -> task`
   - `taskKey -> nextRunAt`
   - `taskKey -> timer`
3. Recompute and reschedule on any config change.
4. Execute tasks reliably and safely.
5. Persist run metadata immediately.
6. Emit UI event after each run outcome.

Scheduling semantics
1. Missed runs while server offline: skip and schedule the next future occurrence.
2. Clock drift: always recompute `nextRunAt` from wall clock after wake.
3. Minimum scheduling granularity: 1 minute.
4. Avoid thundering herd: jitter timers by up to 2 seconds.

Concurrency control
1. Per-task lock in memory (do not allow parallel runs for same task).
2. Per-project cap to avoid overloading OpenCode: configurable concurrency (eg 2).
3. Global cap to avoid overload (eg 4).

Failure handling
1. If OpenCode is not ready, mark run as error and schedule next.
2. If session create fails, mark error and schedule next.
3. If prompt send fails, mark error and schedule next.
4. Persist truncated `lastError`.
5. Never leave `lastStatus=running` indefinitely:
   - set a watchdog timer for max run duration (eg 30m)
   - on timeout, mark error and unlock

Execution details
1. Use server-side OpenCode client.
2. Prefer `@opencode-ai/sdk/v2` client (`createOpencodeClient`) like `opencode/watcher.js`.
3. Flow:
   - `session.create({ directory: project.path, title })`
   - `session.promptAsync({ sessionID, agent, model: { providerID, modelID }, variant, parts: [{type:'text',text:prompt}] })`
4. Do not rely on UI-only optimistic state.

Timezone and cron
1. Production-ready cron parsing should not be handwritten.
2. Add dependencies (preferred):
   - `cron-parser` for cron parsing
   - `luxon` (or equivalent) for timezone-aware date math
3. Daily/weekly schedules should use the same timezone math path (not naive `Date` arithmetic).

---

## UI Events (Refresh Hint)

Problem
1. Server-created sessions do not call `useGlobalSessionsStore.upsertSession(...)` in the client.
2. Without a hint, sidebar global list can lag until a manual refresh.

Solution
1. Add an OpenChamber SSE endpoint:
   - `GET /api/openchamber/events` with `text/event-stream`
2. Scheduler emits `openchamber:scheduled-task-ran` with payload:
   - `{ projectId, taskId, ranAt, status, sessionId? }`
3. UI listens while SessionSidebar is mounted.
4. On event, UI calls `refreshGlobalSessions()` with a small debounce (eg 500ms) to coalesce multiple task runs.
5. Also refresh the currently open Scheduled Tasks dialog if it is open and viewing the same project.

Security
1. SSE endpoint must require the same UI session auth as other `/api/*`.
2. SSE payload must not include secrets.

---

## UI Implementation

Entry point
1. Add icon button in `packages/ui/src/components/session/sidebar/SidebarHeader.tsx`.
2. Icon: `RiCalendarScheduleLine`.
3. Tooltip: `Scheduled tasks`.

Dialog state
1. Add UI store flags in `packages/ui/src/stores/useUIStore.ts`:
   - `isScheduledTasksDialogOpen: boolean`
   - `setScheduledTasksDialogOpen(open: boolean)`
2. Keep editor state local to dialog components (avoid global store fanout).

Dialog mounting
1. Add `ScheduledTasksDialog` component and mount it in `packages/ui/src/components/session/SessionSidebar.tsx` or `SessionDialogs.tsx`.
2. Prefer `SessionSidebar.tsx` if it already owns other sidebar-only dialogs (consistent with `NewWorktreeDialog`).

UI components
1. `packages/ui/src/components/session/ScheduledTasksDialog.tsx`
2. `packages/ui/src/components/session/ScheduledTaskEditorDialog.tsx`

ScheduledTasksDialog behavior
1. On open:
   - default selected project = `useProjectsStore.getActiveProject()`
   - fetch tasks for selected project
2. Project dropdown:
   - uses `useProjectsStore.projects`.
3. Task list:
   - stable sorting by `enabled desc`, then `name`, then `nextRunAt`.
4. Actions:
   - enable toggle persists immediately (server PUT)
   - run now calls server run endpoint
   - edit opens editor dialog
   - delete confirms then deletes
5. After run now:
   - refresh tasks list
   - call `refreshGlobalSessions()`

Editor dialog behavior
1. Create and edit flows.
2. Validation:
   - client-side inline validation for fast feedback
   - server-side validation is authoritative
3. Model selection:
   - reuse `ModelSelector` component
4. Agent selection:
   - reuse `AgentSelector` component
5. Schedule UI:
   - daily: time picker
   - weekly: weekdays multi-select + time picker
   - cron: cron input with validation + helper text
   - timezone: dropdown or input with validation (start with input + server validation, upgrade later)

Mobile
1. Reuse `Dialog` for desktop and `MobileOverlayPanel` where patterns already exist.
2. Do not ship a desktop-only flow.

---

## Server Integration Points

Composition root
1. `packages/web/server/index.js` should:
   - create scheduled tasks runtime
   - register routes
   - start runtime after OpenCode is ready (or handle readiness gating)

Project resolution
1. Use settings runtime `projects[]` as the authoritative mapping of `projectId -> path`.
2. If `projectId` not found, return 404.

---

## Testing

Unit tests (server)
1. Task validation and sanitization.
2. Next-run computation:
   - daily across DST boundaries
   - weekly across DST
   - cron parsing correctness
   - invalid timezone rejection
3. Title formatting in timezone.

Integration tests (server)
1. CRUD endpoints.
2. Run endpoint triggers OpenCode calls (mock SDK client).
3. SSE endpoint emits events on run.

UI tests (if existing infra)
1. Dialog open/close.
2. Project switching fetches tasks.
3. Add/edit validates and persists.
4. Run now triggers refresh.

Manual verification checklist
1. Create a task for a project and verify it runs at the configured time.
2. Verify session title matches `<task_name> <date> <time>`.
3. Verify provider/model/agent/variant are applied.
4. Verify disabling a task stops runs.
5. Verify server restart preserves tasks and scheduling.
6. Verify missed time while server down does not create a burst.
7. Verify UI sidebar shows new sessions without manual reload (via SSE hint -> refreshGlobalSessions).

Repo validation gates
1. `bun run type-check`
2. `bun run lint`
3. `bun run build`

---

## Production Concerns

Security
1. Ensure all new endpoints are behind UI auth.
2. Validate input strictly and avoid writing arbitrary paths.
3. Do not expose prompt content via SSE.

Performance
1. Scheduler must not poll excessively.
2. UI must not subscribe broadly to stores for high-frequency events.
3. Coalesce global session refresh calls.

Reliability
1. Atomic file writes.
2. Locks to avoid concurrent duplicate runs.
3. Watchdog to clear stuck runs.
4. Bounded memory for task indexes.

Observability
1. Structured logs on run start and completion.
2. Log task key, projectId, taskId, status, duration.
3. Avoid logging prompt text.

---

## Concrete File/Code Change List

Server
1. Add `packages/web/server/lib/projects/project-config.js`.
2. Add `packages/web/server/lib/opencode/scheduled-tasks-runtime.js`.
3. Add `packages/web/server/lib/opencode/scheduled-tasks-routes.js`.
4. Wire in `packages/web/server/index.js`.
5. Add SSE route `GET /api/openchamber/events` (new file or extend an existing routes module).
6. Add tests under `packages/web/server/*` test structure.
7. Add deps to root `package.json` if needed (`cron-parser`, `luxon`).

UI
1. Update `packages/ui/src/components/session/sidebar/SidebarHeader.tsx` to add the icon button.
2. Update `packages/ui/src/stores/useUIStore.ts` for dialog open flag.
3. Add `packages/ui/src/components/session/ScheduledTasksDialog.tsx`.
4. Add `packages/ui/src/components/session/ScheduledTaskEditorDialog.tsx`.
5. Mount dialog (prefer `packages/ui/src/components/session/SessionSidebar.tsx`).
6. Add `packages/ui/src/lib/openchamberEvents.ts` (EventSource client) or colocate in dialog.
