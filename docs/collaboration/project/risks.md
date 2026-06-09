# Collaboration risks

- Stale references to `/Users/adam/repos/forge-collab` can send agents to the wrong repo for backend, Docker, or tracking work.
- Local multi-backend testing can mix cookies or data if the primary and secondary Compose services do not keep separate ports, cookie names, and data directories.
- Documentation can drift because collaboration spans backend runtime, Docker deployment, UI settings, auth, specialists, skills, and protocol types.
