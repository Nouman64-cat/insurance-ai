# Legacy Forgery Detection entrypoint

The upload workspace has moved to the authenticated main portal: **Admin → Document Intelligence**, [http://localhost:3000/admin/document-intelligence](http://localhost:3000/admin/document-intelligence).

This legacy Next.js service on port 3012 only links to that page. `/api/analyze` and `/api/performance` return 401; it no longer proxies uploads or results. `PORTAL_URL` controls the portal link. It can be stopped when old bookmarks are no longer needed.

The main portal contains the upload UI, persisted tenant history, report display and JSON downloads. Tenant-service authenticates active tenant Admins and calls docs-forgery over its internal API. Docs-forgery analyzes documents and owns persisted reports in the `docs_forgery` PostgreSQL schema. Original upload bytes are not retained. See the [engine README](../../backend-microservices/docs-forgery/README.md) for setup and storage details.

SuperAdmin configuration and costing remain under Document Forgery Detection and Token Economy. The runtime and quality dashboard is now at `/super-admin/document-forgery/performance` in the main portal.
