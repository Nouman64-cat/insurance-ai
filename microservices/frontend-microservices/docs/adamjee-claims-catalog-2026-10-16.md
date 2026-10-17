# Adamjee claims catalog enrichment — 16 October 2026

The 34 existing retail product codes were matched to the official Adamjee Life
brochures already identified by the surrender catalog. Every brochure was fetched
again. Scanned pages were rendered and OCR-read; benefit descriptions, exclusions,
waiting periods and notification statements were reviewed as plan-specific facts.
The insurer's claims page and claim-information PDF supply separately attributed
general filing guidance. Sources, page/section references, retrieval date and SHA-256
digests are retained in `seeds/data/adamjee_claims_terms.json`.

`InsurancePlan.claims_terms` holds published summaries, base versus optional benefits,
waiting periods, notification requests, exclusions, document lists and filing guidance.
`null` for an undisclosed waiting period is different from Nigraan's explicitly published
zero-day waiting period. COVID's initial 14-day wait is separate from the 15-day gap
required between consecutive hospitalizations. The Parvaaz Savings & Health spouse
rider has an inconsistent covered-life description, which is preserved as a note
rather than inferred away.

Brochure descriptions are not complete policy wording. Optional riders are catalog
options, not evidence that a policyholder purchased them. The data explicitly disables
operational adjudication and requires confirmation of the issued policy version.
Existing claim calculations, approvals, payouts, pricing and underwriting rules are
not changed. Generic/group plans have no Adamjee retail claim terms inferred for them.

## Existing databases

The normal tenant-service startup migration adds the nullable JSON column. For an
existing deployment, restart/rebuild the tenant service before the import if necessary.

```sh
docker compose exec tenant-service python -m seeds.insurance_plan_claims_seed --all-tenants
docker compose exec tenant-service python -m seeds.insurance_plan_claims_seed \
  --all-tenants --apply --backup /app/tmp/adamjee-claims-before-import.json
```

Use repeatable `--tenant-id UUID` instead of `--all-tenants` to limit scope. The importer
only fills missing `claims_terms` on matching product codes whose existing sourced
surrender metadata identifies Adamjee Life. It preserves any manual/existing claim
terms and skips unrelated products. If that source identity has not been populated,
review/import the earlier surrender catalog first. A backup is mandatory for writes;
an existing backup file is never overwritten. Rows are locked and changes committed
in one transaction. A repeated import reports unchanged rows.

New retail plans created through the standard seed receive this claims data from the
same bundled catalog. Running the ordinary plan seed does not backfill existing rows;
use the importer above. No catalog content is fetched from the internet at app startup.

## Local application and validation

Applied to 68 existing records: 34 each in Crescent Life Assurance Ltd. and Mehran
General Insurance Ltd. These are the tenant catalogs that already held the imported
Adamjee products. Ten unrelated products were unchanged. Full-row before/after
comparison confirmed that only `claims_terms` and `updated_at` changed. Repeating the
dry run reported 0 updates, 68 unchanged and 10 skipped.

Local backup: `/app/tmp/adamjee-claims-before-import-20261016.json` in tenant-service.
Full verification snapshot: `/app/tmp/adamjee-claims-full-before-20261016.json`.

Eight focused tests cover catalog coverage, plan/event-specific waits, rider separation,
source/reference validation, defensive copies, dry-run behavior, preserved manual
values, backup protection and repeat-import safety:

```sh
docker compose exec tenant-service python -m unittest test_claims_catalog -v
```

The plan read schema was checked against an imported database record. The portal's
plan drawer displays **Claims & eligibility** beneath early-exit terms, including
source links. Frontend TypeScript checking reported existing errors in e-application,
dashboard maps and shared SSO exports; no errors referred to the claims changes.

## Primary sources

- [Individual-life catalog](https://www.adamjeelife.com/en/individual-life)
- [Claims process](https://www.adamjeelife.com/en/claims)
- [Claim information and documentation](https://www.adamjeelife.com/public/source/policyholder/newConvDocument/Claim-Information-Form.pdf)
- Each plan's brochure URL and page references are stored with that plan's terms.
