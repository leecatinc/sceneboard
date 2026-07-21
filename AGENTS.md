# SceneBoard Agent Instructions

## Rule precedence

1. Start with `rules/CRITICAL.md`, then `rules/RULES.md`.
2. For every file being changed, search from that file's directory upward for the nearest `rules/RULES.md`.
3. A nearer rule tree overrides a broader rule tree when they conflict. Broader safety rules still apply unless the nearer rule is stricter.
4. If a task spans multiple packages, load the nearest applicable rule tree for each package.

## Scope

These instructions apply to the SceneBoard monorepo only. Parent-workspace rules do not override this repository's explicit engineering, language, Git, or QA policies.
