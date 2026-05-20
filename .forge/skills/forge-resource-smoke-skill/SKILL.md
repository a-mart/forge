---
name: forge-resource-smoke-skill
description: Test-only project skill fixture for validating repo-root .forge skill discovery. Use when the user asks to run the Forge resource smoke skill or validate project skill loading.
---

# Forge Resource Smoke Skill

This is a safe, test-only project skill for validating discovery and loading of repo-root skills from `.forge/skills/`.

## When to use

Use this skill only when the user explicitly asks to test, validate, or smoke-check the repo-root Forge project skill fixture.

## Smoke-test task

When invoked, do this deterministic task:

1. Respond with the exact validation phrase: `forge-resource-smoke-skill called`.
2. If the repo-root reference document is available, optionally read `.forge/reference/forge-resource-smoke-reference.md` and cite its validation token: `FRSR-2026-05-20`.
3. Do not perform network calls, credential handling, destructive filesystem operations, or production implementation work.

Expected concise response:

`forge-resource-smoke-skill called; reference token FRSR-2026-05-20`
