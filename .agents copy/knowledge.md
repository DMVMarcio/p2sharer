# Workspace Technical Knowledge Base

## 1. Project Overview & Architecture
- **Ecosystem & Stack**: <Stack details, runtime, primary framework>
- **Primary Design Pattern**: <e.g., Modular Monorepo, Clean Architecture, Harmony Mod Engine>
- **Core Entrypoints**:
  - `src/main.ts` or `Plugin.cs`

## 2. Technical Sectors & Active Subagents
| Sector / Domain | Subagent (`.agents/subagents/`) | Dedicated Skill (`.agents/skills/`) | Scope / Target Files |
| :--- | :--- | :--- | :--- |
| Core / Netcode | `netcode-specialist.md` | `netcode-packet/SKILL.md` | `MultiplayerMod/Network/*` |
| UI & Components | `ui-architect.md` | `canonical-design/SKILL.md` | `MultiplayerMod/UI/*` |

## 3. Subsystem Architectural Deep Dives
<!-- Link to modular markdown files for dense subsystems to prevent index bloat -->
- [Network Protocol & Packet Serialization](.agents/knowledge/netcode.md)
- [HUD & Native Menu Hierarchies](.agents/knowledge/ui-system.md)

## 4. User Guidelines & Expressed Preferences
<!-- Tagged rules captured directly or indirectly from user instructions -->
- `[Git]` Always format commit messages with Conventional Commits in English.
- `[Architecture]` Never use disposable, inline visual components; reuse native host elements.
- `[Modding]` Avoid floating overlay windows; blend directly into native game menus and styles.