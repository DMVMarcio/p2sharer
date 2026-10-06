---
name: project-audit
description: Audits new or unfamiliar repositories, bootstraps the knowledge base (.agents/knowledge.md), initializes the default main orchestrator, validates existing subagents for drift, and creates specialized sector subagents and skills. Use this skill during initial setup or when knowledge.md is missing.
---

# Skill: Initial Discovery, Sectoral Audit & Subagent Validation

## Scope
Executed on first contact with a repository, when `.agents/knowledge.md` is missing or incomplete, or during periodic architectural reviews to prevent agent drift.

## Knowledge Maintenance
Knowledge is a navigation aid for current architecture and explicit standing user rules. It is not a conversation archive, feature specification, task backlog, or completed-work log. Apply the memory criteria in `.agents/rules/agent-persistence.md` when bootstrapping or cleaning it.

- Persist user rules only when explicitly intended to govern future work. "Every button must be circular" qualifies; adding a message sound, moving a control, or renaming a tab does not. Do not turn an example or isolated request into a universal requirement.
- Keep the index short: project overview, subsystem links, explicit standing rules, and essential commands. Keep verified subsystem architecture in its own reference, without presenting it as a user mandate.
- Remove superseded requests, layout minutiae, duplicated rules, approval history, dated validation totals, and personal measurements. Retain only the reusable technical conclusion of a past investigation. Do not move discarded task history to another memory file.
- Audit tests by the behavior they exercise. Preserve production logic, security/consent, data integrity, persistence, lifecycle, and accessibility coverage. Remove tests that merely search implementation text or freeze incidental layout, labels, dimensions, or variable names. Static enforcement of an explicit global rule remains useful.

## 1. Discovery Routine
1. **Manifest Inspection**: Read package files (`package.json`, `Cargo.toml`, `pyproject.toml`, `.csproj`, `CMakeLists.txt`, `go.mod`, etc.) to determine dependencies, runtime, and ecosystem.
2. **Architecture Identification**: Determine the primary design pattern (Clean Architecture, Monorepo, MVC, MVVM, Hexagonal, Event-Driven).
3. **Convention Extraction**: Identify file naming conventions (kebab-case, PascalCase), typing approaches, test runners, and error handling patterns.

## 2. Sectoral Decomposition
Group the codebase into technical sectors based on domain:
- **Web / Fullstack**: UI/Design System, API/Controllers, Persistence/ORM, Test Suite.
- **Desktop / Mobile**: Views/Screens, ViewModels/State, Native OS/Hardware Bridges, Local DB.
- **CLI & Services**: CLI Parser/Commands, Domain Core, External Integrations/IO.
- **Mods & Plugins**: Hook/Injection Points, Host Native UI, Game Balancing/Rules, Assets.

## 3. Main Agent Setup & Synchronization
1. Verify if `.agents/subagents/project-orchestrator.md` exists. If missing, generate it with `mainAgent: true` and `subagent: false`.
2. Sync the orchestrator prompt with discovered architectural entrypoints and active subagents so it acts as the canonical team lead in the Antigravity UI dropdown.

## 4. Subagent Health Check & Drift Validation
Before generating new subagents or when re-auditing an existing project:
1. **Audit Existing Subagents**: Scan `.agents/subagents/*.md` for obsolete target directories, broken skill links, or outdated API patterns.
2. **Enforce Concrete Rules**: Ensure subagents have project-specific architectural assertions instead of generic advice (adhering to `.agents/skills/subagent-management/SKILL.md`).
3. **Sync with Knowledge**: Update `.agents/knowledge.md` to reflect active, verified subagents and retire any that no longer have a domain in the project.

## 5. Subagent & Skill Generation Protocol
When creating specialized sector roles:
1. Generate domain-specific subagents under `.agents/subagents/<sector>.md` using the exact YAML frontmatter defined in `.agents/skills/subagent-management/SKILL.md`.
2. Pair each subagent with its dedicated skill under `.agents/skills/<sector>/SKILL.md`.
3. Bootstrap or update `.agents/knowledge.md` strictly in English with references to all generated subagents, skills, and the main orchestrator.
