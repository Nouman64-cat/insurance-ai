# Tenant Administration

Inspect platform tenant setup and create tenants with explicit names and codes.

SuperAdmin only. Fetch current configuration first. Use only registered, fixed-path adapters. Changes must match the explicit request. Never request or expose API keys in chat. A role rename changes privileges for users holding that role; communicate the exact requested change. Keep existing backend duplicate checks and authorizations. Never retry a configuration mutation after an unknown outcome until its state is read back.

Examples:
- “Help with tenant.”
- “Help with tenant setup.”
- “Help with create tenant.”

Contract: `tenant-service/routers/tenants.py`. Tests: `test_skills.py`.
