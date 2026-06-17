# Collaboration risks

- Documentation can drift because collaboration spans backend runtime, Docker deployment, UI settings, auth, specialists, skills, and protocol types.
- Local multi-backend testing can mix cookies or data if the primary and secondary Compose services do not keep separate ports, cookie names, and data directories.
- Builder-only features can accidentally leak into collaboration UX if agents assume a mounted backend route means the surface is supported.
