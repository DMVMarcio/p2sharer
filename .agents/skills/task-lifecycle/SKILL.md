---
name: task-lifecycle
description: Mandatory lifecycle, scratchpad tracking, checklist progression, multi-task decomposition, and cleanup routines for all tasks executed within the workspace. Use this skill whenever beginning, executing, tracking, or finalizing any feature, bug fix, refactor, or investigation.
---

# Skill: Mandatory Task Lifecycle & In-Flight Tracking

## Scope
Defines the mandatory lifecycle, scratchpad tracking, checklist granularity, multi-task decomposition, and cleanup routines for all tasks executed within the workspace.

---

## 1. The Mandatory Task Gate & Decomposition
Whenever the user asks for changes, bug fixes, refactors, or investigations:
1. **Do not modify or create source code immediately.**
2. **Detect Orthogonal Requirements (Multi-Task Deconstruction)**:
   - Check if the user's prompt combines distinct, independent goals (e.g., *Fix network error popup flow* AND *Adjust HUD layout*).
   - If the items belong to different subsystems or can be verified and committed independently, **create separate task folders for each** (`.agents/tasks/<slug-a>/` and `.agents/tasks/<slug-b>/`), executing them sequentially with independent lifecycles and commits.
   - If tightly coupled, keep them in one task, but enforce independent, granular sub-checklists per requirement.
3. Generate a URL-friendly, short slug for each task (e.g., `fix-connection-error-flow`, `players-hud-layout`).
4. Initialize `.agents/tasks/<task-slug>/task.md` using the canonical template below.
5. Only proceed with workspace mutations **after** this file exists on disk.

---

## 2. Canonical `task.md` Template

The file `.agents/tasks/<task-slug>/task.md` must adhere strictly to this English format:

```markdown
# Task: <Concise Task Title>

- **Status**: [IN_PROGRESS | BLOCKED | COMPLETED]
- **Target Files**:
  - `path/to/file1.cs`
  - `path/to/file2.cs`

## 1. Goal & Requirements
Concise breakdown of user requirements and acceptance criteria.
- Requirement 1: ...
- Requirement 2: ...

## 2. Execution Checklist
<!-- MANDATORY: Do NOT write generic phases like "- [ ] Phase 2: Implementation (do everything)". -->
<!-- Every requirement MUST be broken down into concrete, actionable micro-steps. -->

### Subsystem / Requirement 1: <Name>
- [ ] Inspect <specific function/flow> in `<file>`
- [ ] Modify <specific mechanism/handler> to achieve <behavior>
- [ ] Verify edge case <scenario>

### Subsystem / Requirement 2: <Name>
- [ ] Locate styling / layout parameters in `<file>`
- [ ] Adjust dimensions, anchors, or alignment
- [ ] Validate rendering / behavior across states

### Quality, Validation & Cleanup
- [ ] Build and package full desktop application (`npm run tauri:build`) to verify zero regressions
- [ ] Manual test / automated test verification (`node --experimental-strip-types --test test/unit/*.test.ts`)
- [ ] Transfer durable technical patterns to `.agents/knowledge.md`
- [ ] Atomic Conventional Commit (`feat: ...` or `fix: ...`)

## 3. Temporary Notes & Scratchpad
<!-- Live notes during development: findings, quirks, unexpected behaviors, temporary debugging ideas -->
- Discovered that event `OnConnectionFailed` currently redirects to `TitleMenuState`.

## 4. Architectural Notes to Persist
<!-- Items identified during this task that should be transferred to `.agents/knowledge.md` before deleting this task -->
- None yet.
```

---

## 3. Granularity Enforcement: Anti-Patterns vs Required Patterns

### ❌ Prohibited Anti-Pattern (Lazy Phase-Only Checklist)
```markdown
## 2. Execution Checklist
- [ ] Phase 1: Discovery & Analysis (examine connection error handling)
- [ ] Phase 2: Implementation (fix error callback and adjust HUD)
- [ ] Phase 3: Validation & Quality (verify build)
- [ ] Phase 4: Commit & Finalization
```
*Why prohibited:* It bundles multiple complex code changes into a single vague checkbox. It prevents real-time progress tracking and encourages skipped validations.

###  Mandatory Pattern (Actionable Micro-Steps)
```markdown
## 2. Execution Checklist
### Connection Error Popup
- [ ] Trace `NetworkManager.OnConnectionFailed` invocation path
- [ ] Prevent state machine from switching to `TitleScene` when error payload is present
- [ ] Keep `NativeMultiplayerMenu` active and trigger `ShowErrorPopup(reason)`
- [ ] Test disconnect caused by timeout and kick scenarios

### Players HUD Alignment
- [ ] Inspect height constraint and padding in `PlayersHUD.cs`
- [ ] Reduce container vertical bounds by defined offset
- [ ] Set vertical alignment to center for active player list items
- [ ] Test HUD layout with 1 player, 4 players, and empty lobby

### Completion
- [ ] Verify build and tests pass
- [ ] Persist multiplayer flow insights to `knowledge.md`
- [ ] Commit changes atomically
```

---

## 4. In-Flight Progression Protocol
- **Real-Time Checkbox Updates**: Mark checklist items as `[x]` continuously as each micro-step completes. Do not accumulate checkboxes to mark all at the end.
- **Scratchpad Usage**: Use `## 3. Temporary Notes & Scratchpad` whenever encountering unexpected behavior, API signatures, edge cases, or intermediate thoughts. This keeps context fresh if a turn is interrupted.
- **Transfer to Memory**: If an important pattern or system mechanic was discovered (e.g., how the menu state machine transitions work), copy that insight into `.agents/knowledge.md` or `.agents/knowledge/<subsystem>.md` **before** concluding the task.

---

## 5. Completion & Cleanup Routine
The task directory `.agents/tasks/<task-slug>/` must be deleted **only when all of the following conditions are met**:
1. All checkboxes in `task.md` are marked `[x]`.
2. Any architectural knowledge or user preferences discovered have been transferred to `.agents/knowledge.md`.
3. Code changes have been verified and atomically committed to Git via Conventional Commits.
4. Run the file removal tool on `.agents/tasks/<task-slug>/` to leave the workspace clean.