---
name: subagent-management
description: Governs the canonical creation, frontmatter schema, tool scoping, prompt engineering, and validation/drift detection of specialized Antigravity subagents and the default workspace main agent. Use this skill whenever creating, updating, auditing, or orchestrating agents in .agents/subagents/.
---

# Skill: Subagent Creation, Management & Validation

## Scope
Defines the official Antigravity 2.0 specification for custom subagents and the workspace main agent, including execution symmetry, tool scoping, safety policies, domain-scoped system prompts, and drift validation against evolving codebases.

---

## 1. The Canonical Antigravity Agent Schema
Every agent file located in `.agents/subagents/<agent-name>.md` **must** use Markdown with a YAML frontmatter header conforming strictly to this format:

```markdown
---
name: <kebab-case-name>
description: <Clear, concise description of when and why the main agent or user should invoke this agent>
tools:
  - view_file
  - replace_file_content
  - grep_search
  - file_search
  - run_command
subagent: true
mainAgent: false
model: pro
commandExecutionPolicy: auto
permissionMode: acceptEdits
skills:
  - skills/<associated-skill-name>
---

# System Prompt
You are the dedicated <Role Name> for this workspace. Your role is strictly focused on <domain scope>.

# Context & Domain Scope
- Primary Target Directories: `path/to/subsystem/*`
- Associated Skill: `.agents/skills/<associated-skill-name>/SKILL.md`

# Operational Guidelines
1. Study existing project conventions, abstractions, and design tokens before mutating files.
2. Maintain strict compatibility with neighboring subsystems and public API contracts.
3. Record durable architectural discoveries in `.agents/knowledge.md` or the relevant subsystem knowledge file.
```

---

## 2. YAML Frontmatter Specification Breakdown

| Field | Type | Description / Accepted Values |
| :--- | :--- | :--- |
| `name` | string | Lowercase kebab-case identifier (e.g., `project-orchestrator`, `netcode-specialist`). |
| `description` | string | **Semantic Trigger**: Used by Antigravity's coordinator or router to determine when to delegate a task. |
| `tools` | list | Strict subset of required tools. Only include tools relevant to the agent's domain (e.g., omitting `run_command` if read-only). |
| `subagent` | boolean | Set to `true` if the agent can be dynamically invoked by another agent during execution. |
| `mainAgent` | boolean | Set to `true` if the agent appears directly in the Antigravity UI dropdown and CLI (`agy --agent <name>`). The default workspace coordinator MUST have this set to `true`. |
| `model` | string | `pro` (complex reasoning/architecture), `flash` (rapid repetitive edits/scans), or `inherit`. |
| `commandExecutionPolicy` | string | `auto` (runs compilation/tests autonomously without blocking prompts), `sandbox`, or omitted for manual prompt gating. |
| `permissionMode` | string | `acceptEdits` (streamlined file edits), `readOnly`, or `default`. |
| `skills` | list | Array of skills (`skills/<skill-slug>`) scoped exclusively to this agent's domain. |

---

## 3. The Default Workspace Main Agent (`project-orchestrator.md`)
Every managed workspace should maintain a primary entrypoint agent configured with:
- `mainAgent: true` and `subagent: false`
- Filepath: `.agents/subagents/project-orchestrator.md`
- Responsibilities: Receives user requests from chat, breaks down tasks, consults `.agents/knowledge.md`, and acts as the technical lead orchestrating specialized subagents.

### Progressive Evolution of the Main Agent
As the project evolves, the orchestrator must not remain static. Update `.agents/subagents/project-orchestrator.md` whenever:
1. **New Sectors Emerge**: When a new subagent (e.g., `inventory-system`, `auth-service`) is established, register its capabilities in the orchestrator's domain scope and delegation registry.
2. **Architectural Pivots**: When major libraries, target runtimes, or build pipelines change, reflect these high-level constraints in the orchestrator's prompt.
3. **Subagent Retirement**: If a domain is deprecated, remove references from the orchestrator so it stops delegating to non-existent tools.

---

## 4. Subagent Concreteness & Drift Validation Protocol

As a codebase evolves, agents can suffer from **Instruction Drift**. When auditing existing agents or creating new ones, validate them against:

### A. Concrete vs Vague Guidelines Check
Never allow generic, unhelpful filler rules in agent prompts:
- ❌ **Vague**: "Write clean, readable code and follow best practices."
- ✅ **Concrete**: "Serialize all network packets using `NetSerializer.WriteByte()` and enforce symmetric read order in `NetDeserializer`."
- ❌ **Vague**: "Style UI elements properly."
- ✅ **Concrete**: "Reuse colors defined in `GameColors.cs` and anchor native HUD elements using Unity's `RectTransform` presets matching `BaseGameHUD`."

### B. Workspace Freshness & Drift Verification
Whenever evaluating agents, verify:
1. **Path Validity**: Check if paths listed under `Primary Target Directories` actually exist on disk.
2. **Skill Existence**: Verify that every entry in `skills:` corresponds to an existing `.agents/skills/<name>/SKILL.md` file.
3. **Tool Gating Relevance**: Remove write tools (`replace_file_content`, `run_command`) from read-only auditing agents.
4. **Architectural Alignment**: Cross-reference agent guidelines against `.agents/knowledge.md` and user directives.
