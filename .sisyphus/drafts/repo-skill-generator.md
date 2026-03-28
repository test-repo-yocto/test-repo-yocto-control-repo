# Draft: Repo Skill Generator

## Requirements (confirmed)
- target org: `test-repo-yocto`
- build a new skill
- skill purpose: generate repositories
- user will provide additional rules and constraints

## Technical Decisions
- planning mode only: produce a work plan before any implementation
- treat this as a reusable skill/generator rather than a one-off repo creation script

## Research Findings
- local draft workspace had no existing `.sisyphus/` files before this draft
- background exploration launched to inspect existing skill structures and conventions

## Open Questions
- what exact inputs should the skill accept?
- what repo template/stack combinations must it support?
- should it only create GitHub repos, or also bootstrap local files and setup?
- what outputs define success for the generator?

## Scope Boundaries
- INCLUDE: requirements capture, local skill-pattern research, decision-complete implementation plan
- EXCLUDE: creating the skill itself, creating repos, editing non-`.sisyphus/` files
