# Git Setup

This repo is a private fork of [SawyerHood/middleman](https://github.com/SawyerHood/middleman), hosted at [radopsai/middleman](https://github.com/radopsai/middleman).

## Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `https://github.com/radopsai/middleman.git` | Our private repo — push and pull here |
| `upstream` | `https://github.com/SawyerHood/middleman.git` | Original public repo — fetch for upstream changes |

## Pulling Upstream Changes

To incorporate updates from the original repo:

```sh
git fetch upstream
git merge upstream/main
```

Resolve any conflicts, then push to origin as usual.

## Branch Strategy

- `main` — stable branch, tracks `origin/main`
- Feature branches off `main` for new work
