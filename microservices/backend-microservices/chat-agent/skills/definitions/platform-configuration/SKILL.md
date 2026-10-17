# Platform Configuration

Inspect platform configuration and update existing provider models without handling secrets.

SuperAdmin only. Fetch current configuration first. Use only registered, fixed-path adapters. Changes must match the explicit request. Never request or expose API keys in chat. A role rename changes privileges for users holding that role; communicate the exact requested change. Keep existing backend duplicate checks and authorizations. Never retry a configuration mutation after an unknown outcome until its state is read back.

Examples:
- “Help with platform.”
- “Help with LLM.”
- “Help with provider.”

Contract: `tenant-service/routers/llm_config.py; tenant-service/routers/tokens.py`. Tests: `test_skills.py`.
