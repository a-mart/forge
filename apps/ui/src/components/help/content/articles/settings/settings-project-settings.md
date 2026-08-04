## Project Settings

**Project Settings** is a Builder-only page for one local project. Its scope
does not follow the current conversation: the project header you open stays
selected even when another conversation is active.

Open it from a local project header in either place:

- Right-click the header and choose **Project Settings**.
- Hover the header, or focus its actions button, select the **…** menu, then
  choose **Project Settings**.

## Manage the selected project

Use the page to rename the project, change its working directory, or change its
default manager model and supported reasoning level. Sessions that inherit the
project default follow a later model change; a session with its own override does
not.

Choose **Project secrets** to open **Settings → Secrets** with this project
preselected. Use **Repository resources** to inspect the selected project's
repo-root `.forge` directory: its detected Git root and effective `.forge` path,
passive and executable resource inventory, executable trust state, and any
project/repository-scoped `.forge` override. The override must point to an
existing directory named `.forge`; executable resources remain inactive until
their path is trusted.

The direct header context-menu shortcuts for Rename, Change Default Model,
Change Working Directory, and Project Secrets remain available. **Project
Settings** is unavailable for Cortex and Remote Projects. Repository resources
are managed through **Project Settings → Repository resources**, not as a
top-level Settings tab.
